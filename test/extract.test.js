import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractQuote, parsePrice } from '../src/extract.js';
import { rankQuotes, fallbackSummary, buildPrompt } from '../src/compare.js';

const jsonLdPage = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},
{"@type":"Product","name":"Bosch GSR 12V-15 Drill","sku":"0601868101","brand":{"@type":"Brand","name":"Bosch"},
"offers":{"@type":"Offer","price":"2 499,90","priceCurrency":"CZK","availability":"https://schema.org/InStock",
"seller":{"@type":"Organization","name":"ToolShop CZ"},
"shippingDetails":{"@type":"OfferShippingDetails","deliveryTime":{"@type":"ShippingDeliveryTime","transitTime":{"@type":"QuantitativeValue","minValue":1,"maxValue":2}}}}}]}
</script></head><body><h1>Bosch drill</h1></body></html>`;

const metaPage = `<html><head>
<meta property="og:title" content="Bosch GSR 12V-15 Professional">
<meta property="product:price:amount" content="2350">
<meta property="product:price:currency" content="CZK">
<meta property="product:availability" content="out of stock">
</head><body><p>Dodání do 5-7 pracovních dnů.</p></body></html>`;

const textPage = `<html><head><title>Drill</title></head><body>
<h1>Bosch GSR 12V-15</h1><span class="p">2 299 Kč</span><p>Skladem. Delivery in 3 days.</p></body></html>`;

const brokenPage = `<html><body><h1>Nothing here</h1></body></html>`;

test('parsePrice handles European and US formats', () => {
    assert.equal(parsePrice('2 499,90'), 2499.9);
    assert.equal(parsePrice('1,299.00'), 1299);
    assert.equal(parsePrice('1.299,00'), 1299);
    assert.equal(parsePrice('1,299'), 1299);
    assert.equal(parsePrice('12,50'), 12.5);
    assert.equal(parsePrice(49.5), 49.5);
    assert.equal(parsePrice(''), null);
});

test('extracts from JSON-LD @graph', () => {
    const q = extractQuote(cheerio.load(jsonLdPage), 'https://www.toolshop.cz/p/1');
    assert.equal(q.source, 'json-ld');
    assert.equal(q.price, 2499.9);
    assert.equal(q.currency, 'CZK');
    assert.equal(q.availability, 'in_stock');
    assert.equal(q.supplier, 'ToolShop CZ');
    assert.deepEqual(q.deliveryDays, { min: 1, max: 2 });
});

test('extracts from meta tags and Czech delivery text', () => {
    const q = extractQuote(cheerio.load(metaPage), 'https://www.naradi.cz/x');
    assert.equal(q.source, 'meta');
    assert.equal(q.price, 2350);
    assert.equal(q.availability, 'out_of_stock');
    assert.equal(q.supplier, 'naradi.cz');
    assert.deepEqual(q.deliveryDays, { min: 5, max: 7 });
});

test('falls back to visible text', () => {
    const q = extractQuote(cheerio.load(textPage), 'https://shop.example.com/d');
    assert.equal(q.source, 'text-heuristic');
    assert.equal(q.price, 2299);
    assert.equal(q.currency, 'CZK');
    assert.equal(q.availability, 'in_stock');
    assert.deepEqual(q.deliveryDays, { min: 3, max: 3 });
});

test('reports pages without a price', () => {
    const q = extractQuote(cheerio.load(brokenPage), 'https://empty.example.com');
    assert.ok(q.error);
});

test('ranking prefers in-stock, fast, cheap', () => {
    const pages = [[jsonLdPage, 'https://www.toolshop.cz/p/1'], [metaPage, 'https://www.naradi.cz/x'], [textPage, 'https://shop.example.com/d'], [brokenPage, 'https://empty.example.com']];
    const quotes = pages.map(([html, url]) => extractQuote(cheerio.load(html), url));
    const comparison = rankQuotes(quotes, { quantity: 10 });
    assert.equal(comparison.ranked.length, 3);
    assert.equal(comparison.ranked[comparison.ranked.length - 1].supplier, 'naradi.cz'); // out of stock, slow
    assert.equal(comparison.ranked[0].totalPrice, comparison.ranked[0].price * 10);
    const failed = quotes.filter((q) => q.error);
    const md = fallbackSummary(comparison, failed, { quantity: 10 });
    assert.match(md, /## Recommendation/);
    assert.match(buildPrompt(comparison, failed, { quantity: 10, requirements: 'within 3 days' }), /within 3 days/);
    console.log(md);
});
