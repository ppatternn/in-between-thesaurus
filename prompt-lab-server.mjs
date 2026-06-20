import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8765);
const root = fileURLToPath(new URL('.', import.meta.url));
const maxBodyBytes = 100_000;
const publicFiles = new Set([
    'prompt-lab.html',
    'thesaurus.html',
    'styles.css',
    'script.js',
    'index.html'
]);

const connectPrompt = `Background:

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

const connectSchema = {
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
                    relationship: {
                        type: 'string',
                        enum: ['synonym', 'near_synonym']
                    },
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

const allowedModels = new Set([
    'gpt-5.5-2026-04-23',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini'
]);

function neighborhoodSchema(breadth) {
    const group = maxItems => ({
        type: 'array',
        maxItems,
        items: {
            type: 'object',
            properties: {
                parent: { type: 'string' },
                children: {
                    type: 'array',
                    maxItems: breadth,
                    items: { type: 'string' }
                }
            },
            required: ['parent', 'children'],
            additionalProperties: false
        }
    });

    return {
        type: 'object',
        properties: {
            root: { type: 'string' },
            level_1: {
                type: 'array',
                maxItems: breadth,
                items: { type: 'string' }
            },
            level_2: group(breadth),
            level_3: group(breadth * breadth)
        },
        required: ['root', 'level_1', 'level_2', 'level_3'],
        additionalProperties: false
    };
}

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '': 'application/octet-stream'
};

function send(response, status, body, type = 'application/json; charset=utf-8') {
    response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
}

function sendJson(response, status, data) {
    send(response, status, JSON.stringify(data));
}

async function readJsonBody(request) {
    let size = 0;
    const chunks = [];

    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) throw new Error('Request body is too large.');
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isValidWord(value) {
    return /^[\p{L}]+(?:['\u2019-][\p{L}]+)*$/u.test(value);
}

function extractResponseContent(response) {
    for (const item of response.output || []) {
        for (const content of item.content || []) {
            if (content.type === 'refusal') return { refusal: content.refusal, text: '' };
            if (content.type === 'output_text') return { refusal: '', text: content.text };
        }
    }
    return { refusal: '', text: '' };
}

function validateConnectResult(result, start, end) {
    if (!result || !['path', 'no_path'].includes(result.status)) {
        return 'The model returned an invalid status.';
    }
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
        return 'The model returned an invalid path shape.';
    }
    if (result.status === 'no_path') {
        return result.nodes.length || result.edges.length ?
            'A no_path response must not contain nodes or edges.' : '';
    }
    if (result.nodes.length < 2 || result.nodes.length > 6) {
        return 'A path must contain two to six nodes.';
    }
    if (result.edges.length !== result.nodes.length - 1) {
        return 'The edge count does not match the node count.';
    }
    if (result.nodes[0].toLocaleLowerCase() !== start.toLocaleLowerCase() ||
        result.nodes.at(-1).toLocaleLowerCase() !== end.toLocaleLowerCase()) {
        return 'The returned endpoints do not match the requested words.';
    }
    if (new Set(result.nodes.map(word => word.toLocaleLowerCase())).size !== result.nodes.length) {
        return 'The path contains a repeated word.';
    }
    for (let index = 0; index < result.edges.length; index++) {
        const edge = result.edges[index];
        if (edge.from.toLocaleLowerCase() !== result.nodes[index].toLocaleLowerCase() ||
            edge.to.toLocaleLowerCase() !== result.nodes[index + 1].toLocaleLowerCase()) {
            return `Edge ${index + 1} does not match its adjacent nodes.`;
        }
    }
    return '';
}

function createUpstreamController(request, response) {
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
        if (!response.writableEnded) controller.abort();
    });
    return controller;
}

async function proxyPromptTest(request, response) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: { message: error.message } });
        return;
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const openAIRequest = body.request;

    if (!apiKey || !openAIRequest || typeof openAIRequest !== 'object') {
        sendJson(response, 400, { error: { message: 'An API key and request body are required.' } });
        return;
    }

    const upstreamController = createUpstreamController(request, response);

    try {
        const upstream = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(openAIRequest),
            signal: upstreamController.signal
        });
        const upstreamBody = await upstream.text();
        if (response.destroyed) return;
        send(response, upstream.status, upstreamBody);
    } catch (error) {
        if (response.destroyed || error.name === 'AbortError') return;
        sendJson(response, 502, { error: { message: `Could not reach OpenAI: ${error.message}` } });
    }
}

async function connectWords(request, response) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: { code: 'invalid_request', message: error.message } });
        return;
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const start = typeof body.start === 'string' ? body.start.trim() : '';
    const end = typeof body.end === 'string' ? body.end.trim() : '';

    if (!apiKey) {
        sendJson(response, 401, { error: { code: 'missing_key', message: 'Add an API key in Prompt Lab first.' } });
        return;
    }
    if (!isValidWord(start) || !isValidWord(end) || start.toLocaleLowerCase() === end.toLocaleLowerCase()) {
        sendJson(response, 400, { error: { code: 'invalid_words', message: 'Enter two different single words.' } });
        return;
    }

    const resolvedPrompt = connectPrompt
        .replaceAll('{{start_word}}', start)
        .replaceAll('{{end_word}}', end);
    const openAIRequest = {
        model: 'gpt-5.5',
        input: resolvedPrompt,
        reasoning: { effort: 'medium' },
        max_output_tokens: 3000,
        store: false,
        text: {
            format: {
                type: 'json_schema',
                name: 'lexical_path',
                strict: true,
                schema: connectSchema
            }
        }
    };
    const upstreamController = createUpstreamController(request, response);
    const started = performance.now();

    try {
        const upstream = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(openAIRequest),
            signal: upstreamController.signal
        });
        const upstreamBody = await upstream.json();
        if (response.destroyed) return;
        if (!upstream.ok) {
            const message = upstream.status === 401
                ? 'That API key was not accepted. Update it in Prompt Lab and try again.'
                : upstream.status === 429
                    ? 'OpenAI is busy or this key has reached its usage limit. Try again shortly.'
                    : upstream.status >= 500
                        ? 'OpenAI is temporarily unavailable. Try again shortly.'
                        : 'The connection could not be completed. Check Prompt Lab and try again.';
            sendJson(response, upstream.status, {
                error: {
                    code: upstreamBody.error?.code || 'openai_error',
                    message
                }
            });
            return;
        }

        const content = extractResponseContent(upstreamBody);
        if (content.refusal) {
            sendJson(response, 422, { error: { code: 'refusal', message: content.refusal } });
            return;
        }
        if (!content.text) {
            const reason = upstreamBody.incomplete_details?.reason || upstreamBody.status || 'no output text';
            sendJson(response, 502, {
                error: { code: 'incomplete', message: `The model did not finish: ${reason}.` }
            });
            return;
        }

        let result;
        try {
            result = JSON.parse(content.text);
        } catch {
            sendJson(response, 502, { error: { code: 'invalid_json', message: 'The model returned invalid JSON.' } });
            return;
        }

        const validationError = validateConnectResult(result, start, end);
        if (validationError) {
            sendJson(response, 502, { error: { code: 'invalid_path', message: validationError } });
            return;
        }

        sendJson(response, 200, {
            status: result.status,
            nodes: result.nodes,
            edges: result.edges,
            usage: upstreamBody.usage || null,
            latency: Math.round(performance.now() - started),
            model: upstreamBody.model || openAIRequest.model
        });
    } catch (error) {
        if (response.destroyed || error.name === 'AbortError') return;
        sendJson(response, 502, {
            error: { code: 'connection_error', message: `Could not reach OpenAI: ${error.message}` }
        });
    }
}

function canonicalizeNeighborhood(result, root, breadth, depth) {
    if (!result || !Array.isArray(result.level_1) ||
        !Array.isArray(result.level_2) || !Array.isArray(result.level_3)) {
        return { neighborhood: result, duplicatesRemoved: 0, invalidWordsRemoved: 0 };
    }

    const level1 = [];
    const level1Keys = new Set();
    let duplicatesRemoved = 0;
    let invalidWordsRemoved = 0;
    for (const word of result.level_1) {
        if (!isValidWord(word)) {
            invalidWordsRemoved++;
            continue;
        }
        const key = word.toLocaleLowerCase();
        if (key === root.toLocaleLowerCase() || level1Keys.has(key)) {
            duplicatesRemoved++;
            continue;
        }
        level1Keys.add(key);
        level1.push(word);
        if (level1.length === breadth) break;
    }

    const canonicalizeGroups = (rawGroups, parents) => {
        const groups = new Map();
        for (const group of rawGroups) {
            const parentKey = group.parent.toLocaleLowerCase();
            if (!parents.has(parentKey)) continue;
            if (!groups.has(parentKey)) {
                groups.set(parentKey, { parent: parents.get(parentKey), children: [] });
            }
            const target = groups.get(parentKey);
            const childKeys = new Set(target.children.map(child => child.toLocaleLowerCase()));
            for (const child of group.children) {
                if (!isValidWord(child)) {
                    invalidWordsRemoved++;
                    continue;
                }
                const key = child.toLocaleLowerCase();
                if (key === parentKey || childKeys.has(key)) {
                    duplicatesRemoved++;
                    continue;
                }
                if (target.children.length === breadth) break;
                childKeys.add(key);
                target.children.push(child);
            }
        }
        return [...groups.values()];
    };

    const level1Parents = new Map(level1.map(word => [word.toLocaleLowerCase(), word]));
    const level2 = depth >= 2 ? canonicalizeGroups(result.level_2, level1Parents) : [];
    const level2Parents = new Map();
    level2.forEach(group => group.children.forEach(word => {
        const key = word.toLocaleLowerCase();
        if (!level2Parents.has(key)) level2Parents.set(key, word);
    }));
    const level3 = depth === 3 ? canonicalizeGroups(result.level_3, level2Parents) : [];

    return {
        neighborhood: {
            root: result.root,
            level_1: level1,
            level_2: level2,
            level_3: level3
        },
        duplicatesRemoved,
        invalidWordsRemoved
    };
}

function validateNeighborhood(result, root, breadth, depth) {
    if (!result || result.root?.toLocaleLowerCase() !== root.toLocaleLowerCase()) {
        return 'The returned root does not match the requested word.';
    }
    if (!Array.isArray(result.level_1) || !Array.isArray(result.level_2) || !Array.isArray(result.level_3)) {
        return 'The model returned an invalid neighborhood shape.';
    }
    if (result.level_1.length > breadth || result.level_2.length > breadth ||
        result.level_3.length > breadth * breadth) {
        return 'The returned neighborhood exceeds the requested breadth.';
    }
    if (depth === 1 && (result.level_2.length || result.level_3.length)) {
        return 'A one-level neighborhood must have empty deeper levels.';
    }
    if (depth === 2 && result.level_3.length) {
        return 'A two-level neighborhood must have an empty third level.';
    }

    const parents = new Set();
    for (const word of result.level_1) {
        if (!isValidWord(word)) return 'The first level contains an invalid word.';
        const normalized = word.toLocaleLowerCase();
        parents.add(normalized);
    }

    const validateGroups = (groups, validParents, levelName) => {
        const expandedParents = new Set();
        const childWords = new Set();
        for (const group of groups) {
            const parent = group.parent?.toLocaleLowerCase();
            if (!validParents.has(parent) || expandedParents.has(parent) || !Array.isArray(group.children)) {
                return { error: `The ${levelName} contains an invalid or repeated parent.`, childWords };
            }
            if (group.children.length > breadth) {
                return { error: `A ${levelName} branch exceeds the requested breadth.`, childWords };
            }
            expandedParents.add(parent);
            for (const word of group.children) {
                if (!isValidWord(word)) {
                    return { error: `The ${levelName} contains an invalid word.`, childWords };
                }
                childWords.add(word.toLocaleLowerCase());
            }
        }
        return { error: '', childWords };
    };

    const secondLevel = validateGroups(result.level_2, parents, 'second level');
    if (secondLevel.error) return secondLevel.error;
    const thirdLevel = validateGroups(result.level_3, secondLevel.childWords, 'third level');
    if (thirdLevel.error) return thirdLevel.error;
    return '';
}

async function generateNeighborhood(request, response) {
    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: { code: 'invalid_request', message: error.message } });
        return;
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const model = allowedModels.has(body.model) ? body.model : 'gpt-5.4-mini';
    const reasoning = ['low', 'medium', 'high'].includes(body.reasoning) ? body.reasoning : 'low';
    const breadth = Math.min(10, Math.max(2, Number(body.breadth) || 7));
    const depth = Math.min(3, Math.max(1, Number(body.depth) || 2));
    const maxOutputTokens = Math.min(10000, Math.max(1000, Number(body.maxOutputTokens) || 3000));

    if (!apiKey) {
        sendJson(response, 401, { error: { code: 'missing_key', message: 'Add an API key in Prompt Lab first.' } });
        return;
    }
    if (!isValidWord(word)) {
        sendJson(response, 400, { error: { code: 'invalid_word', message: 'Enter one single word.' } });
        return;
    }
    if (!prompt || prompt.length > 8000) {
        sendJson(response, 400, { error: { code: 'invalid_prompt', message: 'Provide a prompt under 8,000 characters.' } });
        return;
    }

    const resolvedPrompt = prompt
        .replaceAll('{{word}}', word)
        .replaceAll('{{breadth}}', String(breadth))
        .replaceAll('{{depth}}', String(depth));
    const openAIRequest = {
        model,
        input: resolvedPrompt,
        reasoning: { effort: reasoning },
        max_output_tokens: maxOutputTokens,
        store: false,
        text: {
            format: {
                type: 'json_schema',
                name: 'synonym_neighborhood',
                strict: true,
                schema: neighborhoodSchema(breadth)
            }
        }
    };
    const upstreamController = createUpstreamController(request, response);
    const started = performance.now();

    try {
        const upstream = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(openAIRequest),
            signal: upstreamController.signal
        });
        const upstreamBody = await upstream.json();
        if (response.destroyed) return;
        if (!upstream.ok) {
            sendJson(response, upstream.status, {
                error: {
                    code: upstreamBody.error?.code || 'openai_error',
                    message: upstream.status === 401 ?
                        'That API key was not accepted. Update it in Prompt Lab and try again.' :
                        upstreamBody.error?.message || `OpenAI returned ${upstream.status}.`
                }
            });
            return;
        }

        const content = extractResponseContent(upstreamBody);
        if (content.refusal) {
            sendJson(response, 422, { error: { code: 'refusal', message: content.refusal } });
            return;
        }
        if (!content.text) {
            const reason = upstreamBody.incomplete_details?.reason || upstreamBody.status || 'no output text';
            sendJson(response, 502, {
                error: { code: 'incomplete', message: `The model did not finish: ${reason}.` }
            });
            return;
        }

        let result;
        try {
            result = JSON.parse(content.text);
        } catch {
            sendJson(response, 502, { error: { code: 'invalid_json', message: 'The model returned invalid JSON.' } });
            return;
        }
        const canonical = canonicalizeNeighborhood(result, word, breadth, depth);
        result = canonical.neighborhood;
        const validationError = validateNeighborhood(result, word, breadth, depth);
        if (validationError) {
            sendJson(response, 502, { error: { code: 'invalid_neighborhood', message: validationError } });
            return;
        }

        sendJson(response, 200, {
            neighborhood: result,
            usage: upstreamBody.usage || null,
            latency: Math.round(performance.now() - started),
            model: upstreamBody.model || model,
            resolvedPrompt,
            duplicatesRemoved: canonical.duplicatesRemoved,
            invalidWordsRemoved: canonical.invalidWordsRemoved
        });
    } catch (error) {
        if (response.destroyed || error.name === 'AbortError') return;
        sendJson(response, 502, {
            error: { code: 'connection_error', message: `Could not reach OpenAI: ${error.message}` }
        });
    }
}

async function serveFile(request, response) {
    const requestUrl = new URL(request.url, `http://${host}:${port}`);
    const pathname = requestUrl.pathname === '/' ? '/prompt-lab.html' : requestUrl.pathname;
    const relativePath = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    const filePath = join(root, relativePath);

    if (!filePath.startsWith(root) || !publicFiles.has(relativePath)) {
        sendJson(response, 403, { error: { message: 'Forbidden.' } });
        return;
    }

    try {
        const file = await readFile(filePath);
        send(response, 200, file, contentTypes[extname(filePath)] || contentTypes['']);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
            sendJson(response, 404, { error: { message: 'Not found.' } });
            return;
        }
        sendJson(response, 500, { error: { message: 'Could not read the requested file.' } });
    }
}

const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/prompt-test') {
        await proxyPromptTest(request, response);
        return;
    }
    if (request.method === 'POST' && request.url === '/api/connect') {
        await connectWords(request, response);
        return;
    }
    if (request.method === 'POST' && request.url === '/api/neighborhood') {
        await generateNeighborhood(request, response);
        return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
        await serveFile(request, response);
        return;
    }
    sendJson(response, 405, { error: { message: 'Method not allowed.' } });
});

server.listen(port, host, () => {
    console.log(`Prompt Lab running at http://${host}:${port}/prompt-lab.html`);
});
