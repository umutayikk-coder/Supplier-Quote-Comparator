// Turns the scraped quotes into a comparison. A deterministic ranking always runs,
// so the Actor is useful without an API key; Claude adds the buyer-style write-up.

export function rankQuotes(quotes, { quantity = 1, weights = { price: 0.6, delivery: 0.25, stock: 0.15 } } = {}) {
    const valid = quotes.filter((q) => !q.error && q.price !== null);
    if (valid.length === 0) return { ranked: [], currencies: [], mixedCurrencies: false };

    const currencies = [...new Set(valid.map((q) => q.currency).filter(Boolean))];
    const prices = valid.map((q) => q.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const days = valid.map((q) => q.deliveryDays?.max).filter((d) => d !== null && d !== undefined);
    const minD = days.length ? Math.min(...days) : null;
    const maxD = days.length ? Math.max(...days) : null;

    const scale = (v, lo, hi) => (hi === lo ? 1 : 1 - (v - lo) / (hi - lo)); // lower is better

    const ranked = valid
        .map((q) => {
            const priceScore = scale(q.price, minP, maxP);
            const deliveryScore = q.deliveryDays?.max != null && minD !== null ? scale(q.deliveryDays.max, minD, maxD) : 0.5;
            const stockScore = { in_stock: 1, backorder: 0.4, unknown: 0.5, out_of_stock: 0 }[q.availability] ?? 0.5;
            let score = weights.price * priceScore + weights.delivery * deliveryScore + weights.stock * stockScore;
            // A cheap quote you can't get is not a good quote: out-of-stock is penalized hard.
            if (q.availability === 'out_of_stock') score *= 0.5;
            return {
                ...q,
                totalPrice: Math.round(q.price * quantity * 100) / 100,
                score: Math.round(score * 100),
            };
        })
        .sort((a, b) => b.score - a.score)
        .map((q, i) => ({ rank: i + 1, ...q }));

    return { ranked, currencies, mixedCurrencies: currencies.length > 1 };
}

export function buildPrompt({ ranked, mixedCurrencies }, failed, { quantity, requirements }) {
    const rows = ranked.map((q) => ({
        rank: q.rank,
        supplier: q.supplier,
        product: q.name,
        sku: q.sku,
        unitPrice: q.price,
        currency: q.currency,
        totalForQuantity: q.totalPrice,
        availability: q.availability,
        deliveryDays: q.deliveryDays,
        heuristicScore: q.score,
        dataSource: q.source,
        url: q.url,
    }));

    return `You are a procurement analyst preparing a short quote comparison for a buyer.

Quantity needed: ${quantity}
Buyer requirements: ${requirements || 'none given'}
${mixedCurrencies ? 'Note: quotes are in different currencies. Do not convert with invented rates; say a conversion is needed.\n' : ''}
Scraped quotes (JSON):
${JSON.stringify(rows, null, 2)}

Pages that could not be read: ${failed.length ? failed.map((f) => `${f.url} (${f.error})`).join('; ') : 'none'}

Write the comparison in Markdown with exactly these sections:
## Recommendation
One or two sentences naming the supplier to award and why.
## Comparison
A table: supplier, unit price, total, stock, delivery.
## Risks and checks before ordering
Up to 4 bullets: e.g. products that may not be the same item (different SKU/name), missing delivery data, stock risk, data scraped by heuristic rather than structured data.

Only use facts from the JSON. If something is unknown, say so.`;
}

export async function claudeSummary(prompt, { apiKey, model }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 1200,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

export function fallbackSummary({ ranked, mixedCurrencies }, failed, { quantity }) {
    if (!ranked.length) return '## Recommendation\nNo usable quotes were found.';
    const best = ranked[0];
    const fmtDays = (d) => (d ? (d.min === d.max ? `${d.max} days` : `${d.min}–${d.max} days`) : 'unknown');
    const lines = [
        '## Recommendation',
        `Highest score: **${best.supplier}** at ${best.price} ${best.currency ?? ''} per unit (${best.availability}, delivery ${fmtDays(best.deliveryDays)}).`,
        '',
        '## Comparison',
        '| # | Supplier | Unit price | Total | Stock | Delivery | Score |',
        '|---|---|---|---|---|---|---|',
        ...ranked.map((q) => `| ${q.rank} | ${q.supplier} | ${q.price} ${q.currency ?? ''} | ${q.totalPrice} | ${q.availability} | ${fmtDays(q.deliveryDays)} | ${q.score} |`),
        '',
        '## Risks and checks before ordering',
    ];
    if (mixedCurrencies) lines.push('- Quotes are in different currencies; convert before comparing.');
    if (failed.length) lines.push(`- ${failed.length} page(s) could not be read.`);
    if (ranked.some((q) => q.source === 'text-heuristic')) lines.push('- Some prices came from page text, not structured data; verify them.');
    lines.push(`- Quantity ${quantity}: confirm volume pricing with the supplier.`);
    lines.push('', '_Set an Anthropic API key in the input to get an AI-written analysis._');
    return lines.join('\n');
}
