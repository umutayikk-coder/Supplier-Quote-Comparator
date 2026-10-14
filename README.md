# Supplier Quote Comparator

An Apify Actor that does the first pass of a buyer's job: give it the same product on several supplier sites, and it scrapes price, stock and delivery time from each page, ranks the offers, and has Claude write a short RFQ-style comparison with a recommendation and the risks to check before ordering.

I work in procurement digitalization, where comparing quotes by hand (copy price, copy lead time, paste into Excel, repeat) is a daily chore. This is a small prototype of how scraping plus an LLM can take that over.

## What it does

1. **Scrapes** each URL with Crawlee's `CheerioCrawler` (through Apify Proxy by default).
2. **Extracts** a quote in three tiers, from most to least reliable:
   - schema.org `Product`/`Offer` JSON-LD (including `@graph` and `AggregateOffer`)
   - Open Graph / microdata price tags
   - visible-text heuristics (price + currency, "in stock", "delivery in 3–5 days", including Czech wording)
   
   Every quote records which tier it came from, so a buyer knows how much to trust it.
3. **Ranks** the offers with a transparent weighted score (price 60%, delivery 25%, stock 15%; out-of-stock offers are penalized).
4. **Summarizes** with Claude: recommendation, comparison table, and risks such as "these two listings may not be the same item" or "this price came from page text". With no API key, a rule-based summary is produced instead, so the Actor works either way.

## Input

| Field | Required | Description |
|---|---|---|
| `productUrls` | yes | Two or more product pages for the same item |
| `quantity` | no | Units needed; used for totals (default 1) |
| `requirements` | no | Plain-language needs, e.g. "needed within 5 days" |
| `anthropicApiKey` | no | Enables the Claude write-up (stored as a secret) |
| `model` | no | Claude model (default `claude-sonnet-5-5`) |
| `useProxy` | no | Use Apify Proxy (default true) |

## Output

- **Dataset:** one row per quote: rank, supplier, product, unit price, currency, total, stock, delivery days, score, data source, URL.
- **Key-value store:** `COMPARISON.md` (the write-up) and `OUTPUT` (JSON summary with the recommended quote).

## Run it

```bash
npm install
npm test            # extraction + ranking tests against fixture pages
apify run           # local run, reads storage/key_value_stores/default/INPUT.json
apify push          # deploy to your Apify account
```

## Limits (honest list)

- Sites that render prices with JavaScript only, or block bots hard, need a `PlaywrightCrawler` variant; this version uses plain HTTP.
- No currency conversion: mixed currencies are flagged, not converted.
- It trusts that the URLs are the same product; Claude is asked to flag mismatches, but it is a check, not a guarantee.

## How it was built

I built this in an evening with Claude as a coding assistant. The problem comes from my day job in procurement, where buyers compare supplier quotes by hand. I chose what to build and what a buyer needs to see; Claude wrote most of the code and tests. Testing against sample pages caught two real bugs: text from neighbouring HTML elements merging into wrong prices, and out-of-stock offers outranking available ones.

## License

MIT
