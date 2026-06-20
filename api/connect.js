const CONNECT_PROMPT = `Background:

You are part of a product called "In-Between Thesaurus," which visualizes
a synonym path between two words.

Task:

Create the shortest reasonable path from "{{start_word}}" to
"{{end_word}}".

Each pair of adjacent words must be synonyms, near-synonyms, or
interchangeable in at least one common context. Do not connect words merely because they are associated with the same topic.

Use no more than four intermediate single words. Preserve
"{{start_word}}" and "{{end_word}}" as the first and last nodes.

Return only the path in this format: word -> word -> word

Return no_path only when no reasonable path exists within four
intermediate words.`;

const CONNECT_SCHEMA = {
    type: 'object',
    properties: {
        status: { type: 'string', enum: ['path', 'no_path'] },
        nodes: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6
        },
        edges: {
            type: 'array',
            maxItems: 5,
            items: {
                type: 'object',
                properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    relationship: { type: 'string', enum: ['synonym', 'near_synonym'] },
                    shared_sense: { type: 'string' },
                    justification: { type: 'string' }
                },
                required: ['from', 'to', 'relationship', 'shared_sense', 'justification'],
                additionalProperties: false
            }
        }
    },
    required: ['status', 'nodes', 'edges'],
    additionalProperties: false
};

const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateBuckets = globalThis.__inBetweenRateBuckets || new Map();
globalThis.__inBetweenRateBuckets = rateBuckets;

function send(response, status, body, extraHeaders = {}) {
    response.status(status);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
    response.json(body);
}

function isValidWord(value) {
    return typeof value === 'string' && /^[\p{L}]+(?:['\u2019-][\p{L}]+)*$/u.test(value);
}

function clientAddress(request) {
    const forwarded = request.headers['x-forwarded-for'];
    return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || request.socket?.remoteAddress || 'unknown')
        .split(',')[0]
        .trim();
}

function consumeRateLimit(request) {
    const now = Date.now();
    const key = clientAddress(request);
    const bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
        rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return { allowed: true, retryAfter: 0 };
    }
    if (bucket.count >= RATE_LIMIT) {
        return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }
    bucket.count++;
    return { allowed: true, retryAfter: 0 };
}

function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

function responseContent(response) {
    for (const item of response.output || []) {
        for (const content of item.content || []) {
            if (content.type === 'refusal') return { refusal: content.refusal, text: '' };
            if (content.type === 'output_text') return { refusal: '', text: content.text };
        }
    }
    return { refusal: '', text: '' };
}

function validatePath(result, start, end) {
    if (!result || !['path', 'no_path'].includes(result.status) ||
        !Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
        return 'The model returned an invalid path.';
    }
    if (result.status === 'no_path') {
        return result.nodes.length || result.edges.length ? 'The model returned an invalid no_path result.' : '';
    }
    if (result.nodes.length < 2 || result.nodes.length > 6 || result.edges.length !== result.nodes.length - 1) {
        return 'The model returned an invalid path length.';
    }
    if (result.nodes.some(word => !isValidWord(word)) ||
        result.nodes[0].toLocaleLowerCase() !== start.toLocaleLowerCase() ||
        result.nodes.at(-1).toLocaleLowerCase() !== end.toLocaleLowerCase()) {
        return 'The model returned invalid path nodes.';
    }
    const normalized = result.nodes.map(word => word.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) return 'The model returned a repeated word.';
    for (let index = 0; index < result.edges.length; index++) {
        const edge = result.edges[index];
        if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string' ||
            edge.from.toLocaleLowerCase() !== normalized[index] ||
            edge.to.toLocaleLowerCase() !== normalized[index + 1]) {
            return 'The model returned a discontinuous path.';
        }
    }
    return '';
}

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        send(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, { Allow: 'POST' });
        return;
    }
    if (!sameOrigin(request)) {
        send(response, 403, { error: { code: 'forbidden', message: 'This request origin is not allowed.' } });
        return;
    }
    if (!process.env.OPENAI_API_KEY) {
        send(response, 503, { error: { code: 'missing_configuration', message: 'The word connection service is not configured yet.' } });
        return;
    }

    const rate = consumeRateLimit(request);
    if (!rate.allowed) {
        send(
            response,
            429,
            { error: { code: 'rate_limited', message: 'That is enough exploring for the moment. Try again later.' } },
            { 'Retry-After': String(rate.retryAfter) }
        );
        return;
    }

    let body;
    try {
        body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body || {};
    } catch {
        send(response, 400, { error: { code: 'invalid_json', message: 'The request body is invalid.' } });
        return;
    }
    const start = typeof body.start === 'string' ? body.start.trim() : '';
    const end = typeof body.end === 'string' ? body.end.trim() : '';
    if (!isValidWord(start) || !isValidWord(end) || start.toLocaleLowerCase() === end.toLocaleLowerCase()) {
        send(response, 400, { error: { code: 'invalid_words', message: 'Enter two different single words.' } });
        return;
    }

    const prompt = CONNECT_PROMPT
        .replaceAll('{{start_word}}', start)
        .replaceAll('{{end_word}}', end);
    const started = Date.now();

    try {
        const upstream = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-5.5',
                input: prompt,
                reasoning: { effort: 'medium' },
                max_output_tokens: 3000,
                store: false,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'lexical_path',
                        strict: true,
                        schema: CONNECT_SCHEMA
                    }
                }
            }),
            signal: AbortSignal.timeout(28000)
        });
        const upstreamBody = await upstream.json();
        if (!upstream.ok) {
            const message = upstream.status === 429 ?
                'The word connection service is busy. Try again shortly.' : 'The connection could not be completed.';
            send(response, upstream.status === 429 ? 429 : 502, {
                error: { code: upstreamBody.error?.code || 'openai_error', message }
            });
            return;
        }

        const content = responseContent(upstreamBody);
        if (content.refusal || !content.text) {
            send(response, 502, { error: { code: 'missing_output', message: 'No word path was returned.' } });
            return;
        }
        const result = JSON.parse(content.text);
        const validationError = validatePath(result, start, end);
        if (validationError) {
            send(response, 502, { error: { code: 'invalid_path', message: validationError } });
            return;
        }

        send(response, 200, {
            status: result.status,
            nodes: result.nodes,
            edges: result.edges,
            usage: upstreamBody.usage || null,
            latency: Date.now() - started,
            model: upstreamBody.model || 'gpt-5.5'
        });
    } catch (error) {
        const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
        send(response, timedOut ? 504 : 502, {
            error: {
                code: timedOut ? 'timeout' : 'connection_error',
                message: timedOut ? 'The word search took too long. Try again.' : 'The connection service is temporarily unavailable.'
            }
        });
    }
}
