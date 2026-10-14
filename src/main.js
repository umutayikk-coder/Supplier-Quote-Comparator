import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { extractQuote } from './extract.js';
import { rankQuotes, buildPrompt, claudeSummary, fallbackSummary } from './compare.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    productUrls = [],
    quantity = 1,
    requirements = '',
    anthropicApiKey = process.env.ANTHROPIC_API_KEY,
    model = 'claude-sonnet-5-5',
    useProxy = true,
} = input;

const urls = productUrls.map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean);
if (urls.length < 2) {
    throw new Error('Give at least two product URLs (the same item from different suppliers).');
}

const quotes = [];
const proxyConfiguration = useProxy ? await Actor.createProxyConfiguration() : undefined;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, $ }) {
        const quote = extractQuote($, request.loadedUrl ?? request.url);
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

let summary;
let summarySource = 'rule-based';
if (anthropicApiKey && comparison.ranked.length) {
    try {
        summary = await claudeSummary(buildPrompt(comparison, failed, { quantity, requirements }), {
            apiKey: anthropicApiKey,
            model,
        });
        summarySource = `claude (${model})`;
    } catch (err) {
        log.warning(`Claude call failed, using rule-based summary: ${err.message}`);
    }
}
summary ??= fallbackSummary(comparison, failed, { quantity });

await Actor.setValue('COMPARISON.md', summary, { contentType: 'text/markdown' });
await Actor.setValue('OUTPUT', {
    quantity,
    requirements,
    summarySource,
    quotesFound: comparison.ranked.length,
    pagesFailed: failed.length,
    recommended: comparison.ranked[0] ?? null,
    summary,
});

log.info(`Done. ${comparison.ranked.length} quotes compared, summary by ${summarySource}.`);
await Actor.exit();
