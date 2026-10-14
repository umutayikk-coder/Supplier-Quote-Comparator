// Search mode: turn a product name into a list of shop product pages.
// Uses Apify's own Google Search Scraper Actor, then filters out marketplaces,
// price-comparison sites and non-shop pages, keeping one URL per shop.

import { hostOf } from './extract.js';

// Sites that list many sellers or aren't shops. Comparing against them would
// double-count offers or compare a review against a price.
export const DEFAULT_EXCLUDED_DOMAINS = [
    'heureka.cz', 'heureka.sk', 'zbozi.cz', 'srovname.cz', 'glami.cz', 'pricemania.cz', 'pricemania.sk',
    'ceneo.pl', 'idealo.de', 'idealo.co.uk', 'geizhals.de', 'pricespy.co.uk', 'pricerunner.com',
    'google.com', 'google.cz', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com',
    'twitter.com', 'reddit.com', 'wikipedia.org', 'rtings.com', 'bazos.cz', 'sbazar.cz', 'aukro.cz',
    'ebay.com', 'ebay.de', 'aliexpress.com', 'temu.com',
];

// URL paths that are almost never a single product page.
const NON_PRODUCT_PATH = /\/(search|hledat|vyhledavani|recenze|review|reviews|blog|clanek|clanky|magazin|news|forum|compare|srovnani)(\/|\?|$)/i;

function isExcluded(host, excluded) {
    return excluded.some((d) => host === d || host.endsWith(`.${d}`));
}

export function pickShopUrls(searchResults, { maxShops = 6, excludedDomains = DEFAULT_EXCLUDED_DOMAINS } = {}) {
    const seenHosts = new Set();
    const picked = [];
    const skipped = [];
    for (const r of searchResults) {
        const url = r.url;
        if (!url || !/^https?:\/\//.test(url)) continue;
        const host = hostOf(url);
        let reason = null;
        if (isExcluded(host, excludedDomains)) reason = 'marketplace / comparison / non-shop site';
        else if (NON_PRODUCT_PATH.test(new URL(url).pathname)) reason = 'not a product page';
        else if (seenHosts.has(host)) reason = 'duplicate shop';
        if (reason) {
            skipped.push({ url, reason });
            continue;
        }
        seenHosts.add(host);
        picked.push(url);
        if (picked.length >= maxShops) break;
    }
    return { picked, skipped };
}

const normalize = (s) => String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Words that carry identity: model numbers ("3s", "12v-15") and real words.
// Filler like "the", "for", "s" is ignored.
export function keyTokens(query) {
    const stop = new Set(['the', 'for', 'and', 'with', 'pro', 'cena', 'koupit', 'price', 'buy']);
    return [...new Set(normalize(query).split(' '))]
        .filter((t) => (/\d/.test(t) && t.length >= 2) || (t.length >= 3 && !stop.has(t)));
}

// Does the scraped product name plausibly describe the searched product?
// Every token containing a digit (model numbers) must appear; at least 75% of all tokens must.
export function matchesQuery(name, query) {
    const tokens = keyTokens(query);
    if (!tokens.length) return { match: true, score: 1 };
    const hay = ` ${normalize(name)} `;
    // Whole word or word prefix ("grafit" matches "grafitova"), never mid-word,
    // so "3s" does not match "13s".
    const has = (t) => hay.includes(` ${t}`);
    const modelTokens = tokens.filter((t) => /\d/.test(t));
    if (modelTokens.some((t) => !has(t))) return { match: false, score: 0 };
    const hits = tokens.filter(has).length;
    const score = hits / tokens.length;
    // 75%: with 3 key words all must match ("MX Anywhere 3S" is not "MX Master 3S"),
    // with 4+ one word may differ (shops phrase names differently).
    return { match: score >= 0.75, score: Math.round(score * 100) / 100 };
}

export async function searchShops(Actor, log, { productQuery, countryCode, searchSuffix, maxShops, excludedDomains }) {
    const query = [productQuery, searchSuffix].filter(Boolean).join(' ');
    log.info(`Searching Google (${countryCode}) for: "${query}"`);

    let run;
    try {
        run = await Actor.call('apify/google-search-scraper', {
            queries: query,
            countryCode,
            maxPagesPerQuery: 2,
        });
    } catch (err) {
        throw new Error(
            `Could not run apify/google-search-scraper (${err.message}). `
            + 'If this is a permissions error, open this Actor\'s Settings and switch "Actor permissions" to Full, then run again. '
            + 'Or pass productUrls directly instead of productQuery.',
        );
    }
    if (run.status !== 'SUCCEEDED') throw new Error(`Google search run ended with status ${run.status}`);

    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const { items } = await ds.getData();
    const organic = items.flatMap((page) => page.organicResults ?? []);
    log.info(`Search returned ${organic.length} organic results.`);

    return pickShopUrls(organic, { maxShops, excludedDomains });
}
