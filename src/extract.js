// Pulls quote data (name, price, currency, stock, delivery) out of a product page.
// Strategy: schema.org JSON-LD first (most e-shops publish it for Google Shopping),
// then microdata / Open Graph meta tags, then visible-text heuristics as a last resort.

const IN_STOCK = /instock|in_stock|in stock|skladem|na sklade|available|dostupn/i;
const OUT_OF_STOCK = /outofstock|out_of_stock|out of stock|soldout|sold out|nedostupn|vyprodáno|unavailable/i;

export function parsePrice(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    let s = String(raw).replace(/[^\d.,\s]/g, '').trim().replace(/\s+/g, '');
    if (!s) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
        // whichever separator comes last is the decimal one
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma > -1) {
        // "1,299" (thousands) vs "12,50" (decimal)
        s = /,\d{3}$/.test(s) && s.length > 4 ? s.replace(/,/g, '') : s.replace(',', '.');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function normalizeAvailability(raw) {
    if (!raw) return 'unknown';
    const s = String(raw);
    if (OUT_OF_STOCK.test(s)) return 'out_of_stock';
    if (IN_STOCK.test(s)) return 'in_stock';
    if (/preorder|backorder/i.test(s)) return 'backorder';
    return 'unknown';
}

function flattenJsonLd(node, out = []) {
    if (!node) return out;
    if (Array.isArray(node)) {
        node.forEach((n) => flattenJsonLd(n, out));
    } else if (typeof node === 'object') {
        out.push(node);
        if (node['@graph']) flattenJsonLd(node['@graph'], out);
    }
    return out;
}

function isType(node, type) {
    const t = node['@type'];
    return Array.isArray(t) ? t.includes(type) : t === type;
}

function fromJsonLd($) {
    const nodes = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            flattenJsonLd(JSON.parse($(el).contents().text()), nodes);
        } catch {
            // broken JSON-LD is common; ignore and fall through
        }
    });
    const product = nodes.find((n) => isType(n, 'Product'));
    if (!product) return null;

    let offer = product.offers;
    if (Array.isArray(offer)) offer = offer[0];
    if (offer && isType(offer, 'AggregateOffer')) {
        offer = { ...offer, price: offer.lowPrice ?? offer.price };
    }
    offer = offer || {};

    const shipping = Array.isArray(offer.shippingDetails) ? offer.shippingDetails[0] : offer.shippingDetails;
    const transit = shipping?.deliveryTime?.transitTime;

    return {
        name: product.name ?? null,
        sku: product.sku ?? product.mpn ?? product.gtin13 ?? null,
        brand: typeof product.brand === 'object' ? product.brand?.name ?? null : product.brand ?? null,
        price: parsePrice(offer.price ?? offer.priceSpecification?.price),
        currency: offer.priceCurrency ?? offer.priceSpecification?.priceCurrency ?? null,
        availability: normalizeAvailability(offer.availability),
        seller: typeof offer.seller === 'object' ? offer.seller?.name ?? null : offer.seller ?? null,
        deliveryDays: transit ? { min: transit.minValue ?? null, max: transit.maxValue ?? null } : null,
        source: 'json-ld',
    };
}

function fromMeta($) {
    const meta = (sel) => $(sel).attr('content') ?? null;
    const price = meta('meta[property="product:price:amount"]')
        ?? meta('meta[property="og:price:amount"]')
        ?? $('[itemprop="price"]').first().attr('content')
        ?? $('[itemprop="price"]').first().text();
    if (!price) return null;
    return {
        name: meta('meta[property="og:title"]') ?? ($('[itemprop="name"]').first().text().trim() || null),
        sku: $('[itemprop="sku"]').first().attr('content') ?? ($('[itemprop="sku"]').first().text().trim() || null),
        brand: null,
        price: parsePrice(price),
        currency: meta('meta[property="product:price:currency"]')
            ?? meta('meta[property="og:price:currency"]')
            ?? $('[itemprop="priceCurrency"]').first().attr('content') ?? null,
        availability: normalizeAvailability(
            meta('meta[property="product:availability"]')
            ?? $('[itemprop="availability"]').first().attr('href')
            ?? $('[itemprop="availability"]').first().attr('content'),
        ),
        seller: null,
        deliveryDays: null,
        source: 'meta',
    };
}

// $('body').text() glues adjacent elements together ("12V-15" + "2 299" -> "12V-152 299"),
// so join individual text nodes with spaces instead.
function visibleText($) {
    const parts = [];
    $('body').find('*').not('script, style, noscript').contents().each((_, node) => {
        if (node.type === 'text') parts.push(node.data);
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function fromText($) {
    const text = visibleText($);
    // A price is 1-3 digits plus groups of exactly 3 (thousands), optional 1-2 decimals,
    // so "12V-15 2 299 Kč" yields 2299 rather than 152299.
    const num = '(?<!\\d)(\\d{1,3}(?:[ \\u00a0.,]\\d{3})*(?:[.,]\\d{1,2})?)(?!\\d)';
    const cur = '(€|EUR|Kč|CZK|\\$|USD|£|GBP)';
    const m = text.match(new RegExp(`${cur}\\s?${num}|${num}\\s?${cur}`));
    if (!m) return null;
    const symbol = m[1] ?? m[4];
    const currencyMap = { '€': 'EUR', 'Kč': 'CZK', $: 'USD', '£': 'GBP' };
    return {
        name: $('h1').first().text().trim() || $('title').text().trim() || null,
        sku: null,
        brand: null,
        price: parsePrice(m[2] ?? m[3]),
        currency: currencyMap[symbol] ?? symbol,
        availability: normalizeAvailability(text.slice(0, 5000)),
        seller: null,
        deliveryDays: null,
        source: 'text-heuristic',
    };
}

// Delivery promises are rarely in structured data, so look for them in visible text.
function deliveryFromText($) {
    const text = visibleText($);
    const range = text.match(/(?:deliver\w*|ships?|dodání|doručení)[^.]{0,40}?(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:business\s+|working\s+|pracovní\w*\s+)?(?:days|dny|dní|dnů)/i);
    if (range) return { min: Number(range[1]), max: Number(range[2]) };
    const single = text.match(/(?:deliver\w*|ships?|dodání|doručení)[^.]{0,40}?(\d{1,2})\s*(?:business\s+|working\s+|pracovní\w*\s+)?(?:days|dny|dní|dnů)/i);
    if (single) return { min: Number(single[1]), max: Number(single[1]) };
    return null;
}

export function extractQuote($, url) {
    const result = fromJsonLd($) ?? fromMeta($) ?? fromText($);
    if (!result) {
        return { url, supplier: hostOf(url), error: 'No price found on page' };
    }
    if (!result.deliveryDays) result.deliveryDays = deliveryFromText($);
    return { url, supplier: result.seller ?? hostOf(url), ...result };
}

export function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}
