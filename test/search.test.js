import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickShopUrls, matchesQuery, keyTokens } from '../src/search.js';

test('keeps one product page per shop and drops comparison sites', () => {
    const results = [
        { url: 'https://www.heureka.cz/mys-logitech-mx-master-3s/' },
        { url: 'https://www.alza.cz/logitech-mx-master-3s-graphite-d7159866.htm' },
        { url: 'https://www.alza.cz/logitech-mx-master-3s-pale-grey-d7159867.htm' },
        { url: 'https://www.czc.cz/logitech-mx-master-3s/123/produkt' },
        { url: 'https://www.youtube.com/watch?v=abc' },
        { url: 'https://www.datart.cz/recenze/logitech-mx-master-3s' },
        { url: 'https://shop.logitech.com/cs-cz/mx-master-3s' },
        { url: 'https://www.zbozi.cz/vyrobek/logitech-mx-master-3s/' },
    ];
    const { picked, skipped } = pickShopUrls(results, { maxShops: 6 });
    assert.deepEqual(picked, [
        'https://www.alza.cz/logitech-mx-master-3s-graphite-d7159866.htm',
        'https://www.czc.cz/logitech-mx-master-3s/123/produkt',
        'https://shop.logitech.com/cs-cz/mx-master-3s',
    ]);
    const reasons = Object.fromEntries(skipped.map((s) => [new URL(s.url).hostname, s.reason]));
    assert.match(reasons['www.heureka.cz'], /comparison/);
    assert.match(reasons['www.datart.cz'], /not a product page/);
});

test('respects maxShops', () => {
    const results = ['a', 'b', 'c', 'd'].map((x) => ({ url: `https://shop-${x}.cz/p/1` }));
    assert.equal(pickShopUrls(results, { maxShops: 2 }).picked.length, 2);
});

test('key tokens keep model numbers and drop filler', () => {
    assert.deepEqual(keyTokens('Logitech MX Master 3S cena'), ['logitech', 'master', '3s']);
    assert.deepEqual(keyTokens('Bosch GSR 12V-15'), ['bosch', 'gsr', '12v', '15']);
});

test('product match: same product in Czech wording passes', () => {
    assert.equal(matchesQuery('Logitech MX Master 3S Performance Wireless Mouse, grafitová', 'Logitech MX Master 3S').match, true);
    assert.equal(matchesQuery('Myš Logitech MX Master 3S Graphite', 'Logitech MX Master 3S').match, true);
});

test('product match: wrong model or accessory is rejected', () => {
    assert.equal(matchesQuery('Logitech MX Master 3 Graphite', 'Logitech MX Master 3S').match, false); // older model
    assert.equal(matchesQuery('Logitech MX Anywhere 3S', 'Logitech MX Master 3S').match, false);
    assert.equal(matchesQuery('Logitech MX Master 13S', 'Logitech MX Master 3S').match, false); // no mid-word match
});
