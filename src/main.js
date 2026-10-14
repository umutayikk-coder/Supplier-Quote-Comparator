import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { extractQuote } from './extract.js';
import { rankQuotes, buildPrompt, claudeSummary, fallbackSummary } from './compare.js';
import { searchShops, matchesQuery, DEFAULT_EXCLUDED_DOMAINS } from './search.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    productQuery = '',
    productUrls = [],
    countryCode = 'cz',
    searchSuffix = 'cena',
    maxShops = 6,
    excludeDomains = [],
    quantity = 1,
    requirements = '',
    anthropicApiKey = process.env.ANTHROPIC_API_KEY,
    model = 'claude-sonnet-5-5',
    useProxy = true,
} = input;

// Two ways in: a product name (the Actor finds the shops) or explicit URLs.
let urls = productUrls.map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean);
const searchMode = urls.length === 0 && productQuery.trim() !== '';
let searchSkipped = [];

if (searchMode) {
    const { picked, skipped } = await searchShops(Actor, log, {
        productQuery,
        countryCode,
        searchSuffix,
        maxShops,
        excludedDomains: [...DEFAULT_EXCLUDED_DOMAINS, ...excludeDomains],
    });
    urls = picked;
    searchSkipped = skipped;
    log.info(`Picked ${picked.length} shop pages: ${picked.join(', ')}`);
}

if (urls.length < 2) {
    throw new Error(searchMode
        ? `Search found only ${urls.length} usable shop page(s) for "${productQuery}". Try a more specific product name or model number.`
        : 'Give a productQuery, or at least two productUrls (the same item from different suppliers).');
}

const quotes = [];
const proxyConfiguration = useProxy ? await Actor.createProxyConfiguration() : undefined;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, $ }) {
        let quote = extractQuote($, request.loadedUrl ?? request.url);

        // Pages found by search are untrusted: they may be category pages,
        // accessories, or a different model. Only keep real product data that
        // matches what was searched for.
        if (searchMode && !quote.error) {
            if (quote.source === 'text-heuristic') {
                quote = { url: quote.url, supplier: quote.supplier, error: 'No structured product data (likely not a product page)' };
            } else {
                const m = matchesQuery(quote.name, productQuery);
                if (!m.match) {
                    quote = { url: quote.url, supplier: quote.supplier, name: quote.name, error: `Product name does not match search ("${quote.name}")` };
                } else {
                    quote.matchScore = m.score;
                }
            }
        }

        log.info(`${quote.supplier}: ${quote.error ?? `${quote.price} ${quote.currency} (${quote.source})`}`);
        quotes.push(quote);
    },
    async failedRequestHandler({ request }, error) {
        quotes.push({ url: request.url, supplier: request.url, error: error.message });
    },
});

await crawler.run(urls);

const failed = quotes.filter((q) => q.error);
const comparison = rankQuotes(quotes, { quantity });
await Actor.pushData(comparison.ranked.length ? comparison.ranked : quotes);

const context = { quantity, requirements, productQuery: searchMode ? productQuery : null };

let summary;
let summarySource = 'rule-based';
if (anthropicApiKey && comparison.ranked.length) {
    try {
        summary = await claudeSummary(buildPrompt(comparison, failed, context), {
            apiKey: anthropicApiKey,
            model,
        });
        summarySource = `claude (${model})`;
    } catch (err) {
        log.warning(`Claude call failed, using rule-based summary: ${err.message}`);
    }
}
summary ??= fallbackSummary(comparison, failed, context);

await Actor.setValue('COMPARISON.md', summary, { contentType: 'text/markdown' });
await Actor.setValue('OUTPUT', {
    mode: searchMode ? 'search' : 'urls',
    productQuery: searchMode ? productQuery : null,
    quantity,
    requirements,
    summarySource,
    quotesFound: comparison.ranked.length,
    pagesFailed: failed.length,
    recommended: comparison.ranked[0] ?? null,
    pagesRejected: failed.map((f) => ({ url: f.url, reason: f.error })),
    searchResultsSkipped: searchSkipped,
    summary,
});

log.info(`Done. ${comparison.ranked.length} quotes compared, summary by ${summarySource}.`);
await Actor.exit();
