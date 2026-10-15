# Supplier Quote Comparator

An Apify Actor that does the first pass of a buyer's job: type a product name (or give shop URLs yourself), and it finds the shops selling it, scrapes price, stock and delivery time from each page, ranks the offers, and has Claude write a short RFQ-style comparison with a recommendation and the risks to check before ordering.

I work in procurement digitalization, where comparing quotes by hand (copy price, copy lead time, paste into Excel, repeat) is a daily chore. This is a small prototype of how scraping plus an LLM can take that over.

## Example: what the buyer gets

Real run, 14 Oct 2026. Input: Logitech MX Master 3S on three shop pages, 10 units, *"Need 10 units within 5 working days for a new team"*. Written by Claude (claude-sonnet-5-5):

> **Recommendation**
> Award to **logitech.com**, which lists the MX Master 3S at 1,999 CZK per unit (19,990 CZK for 10), less than half the price of eshop.comfeel.cz, and shows it in stock. Delivery time is not stated by either supplier, so confirm that 10 units can arrive within 5 working days before ordering.
>
> | Supplier | Unit price | Total (10 units) | Stock | Delivery |
> |---|---|---|---|---|
> | logitech.com | 1,999 CZK | 19,990 CZK | In stock | Unknown |
> | eshop.comfeel.cz | 4,149 CZK | 41,490 CZK | In stock | Unknown |
>
> **Risks and checks before ordering**
> - **Product match is unclear:** logitech.com lists "MX Master 3S Verze Bluetooth" with no SKU, while comfeel lists "MX Master 3S, Graphite" (SKU 288929). Confirm they are the same model and colour.
> - **Delivery is unconfirmed** against the 5-working-day requirement.
> - **Limited coverage:** x-kom.pl blocked the scraper (403), so only two quotes were compared. The 2,150 CZK gap is large; confirm VAT and shipping terms.

The most useful line is the product-match warning: the cheapest offer may be a different variant. That is exactly the mistake a buyer makes when comparing on price alone.

More runs in [`examples/`](examples/).

## What it does

0. **Finds shops** (search mode): runs Apify's [Google Search Scraper](https://apify.com/apify/google-search-scraper) for the product name, drops marketplaces, price-comparison sites, reviews and duplicate shops, and keeps one product page per shop.
1. **Scrapes** each URL with Crawlee's `CheerioCrawler` (through Apify Proxy by default).
2. **Extracts** a quote in three tiers, from most to least reliable:
   - schema.org `Product`/`Offer` JSON-LD (including `@graph` and `AggregateOffer`)
   - Open Graph / microdata price tags
   - visible-text heuristics (price + currency, "in stock", "delivery in 3–5 days", including Czech wording)

   Every quote records which tier it came from, so a buyer knows how much to trust it.

   In search mode, pages are only accepted if they have structured product data **and** the product name matches the search (every model number must appear, e.g. "MX Master 3" or "MX Anywhere 3S" are rejected when searching for "MX Master 3S"). Rejected pages are listed with the reason.
3. **Ranks** the offers with a transparent weighted score (price 60%, delivery 25%, stock 15%; out-of-stock offers are penalized).
4. **Summarizes** with Claude: recommendation, comparison table, and risks such as "these two listings may not be the same item" or "this price came from page text". With no API key, a rule-based summary is produced instead, so the Actor works either way.

## Input

| Field | Required | Description |
|---|---|---|
| `productQuery` | one of these two | Product name with model number, e.g. `Logitech MX Master 3S` |
| `productUrls` | one of these two | Two or more product pages for the same item (skips search) |
| `quantity` | no | Units needed; used for totals (default 1) |
| `requirements` | no | Plain-language needs, e.g. "needed within 5 days" |
| `anthropicApiKey` | no | Enables the Claude write-up (stored as a secret) |
| `countryCode` | no | Google country to search in (default `cz`) |
| `searchSuffix` | no | Word added to the search to favour shops (default `cena`) |
| `maxShops` | no | Shop pages to compare (default 6) |
| `excludeDomains` | no | Extra domains to skip in search results |
| `model` | no | Claude model (default `claude-sonnet-5-5`) |
| `useProxy` | no | Use Apify Proxy (default true) |

## Output

- **Dataset:** one row per quote: rank, supplier, product, unit price, currency, total, stock, delivery days, score, data source, URL.
- **Key-value store:** `COMPARISON.md` (the write-up) and `OUTPUT` (JSON summary with the recommended quote, rejected pages and skipped search results with reasons).

## Run it

```bash
npm install
npm test            # extraction, ranking and matching tests against fixture pages
apify run           # local run, reads storage/key_value_stores/default/INPUT.json
apify push          # deploy to your Apify account
```

## Limits (honest list)

- Sites that render prices with JavaScript only, or block bots hard, need a `PlaywrightCrawler` variant; this version uses plain HTTP.
- Search results can mix currencies and product variants. A search for "Bosch GSR 12V-15" on Google CZ returned UK and EU shops, and the ranking compared GBP with EUR and a bare tool with kits that include batteries and accessories. Next steps: local-shops-only filter, single-currency ranking, and buyer-defined exclude words (kit, set, bundle).
- Product matching is name-based. It catches wrong models, but not every variant (colour, Bluetooth vs. receiver bundle); Claude is asked to flag those, but it is a check, not a guarantee.

## How it was built

I built this in an evening with Claude as a coding assistant. The problem comes from my day job in procurement, where buyers compare supplier quotes by hand. I chose what to build and what a buyer needs to see; Claude wrote most of the code and tests. Testing against sample pages caught two real bugs: text from neighbouring HTML elements merging into wrong prices, and out-of-stock offers outranking available ones. Running it on real shops showed that scraping is the easy part; deciding whether two listings are the same product is the hard part.

## License

MIT
