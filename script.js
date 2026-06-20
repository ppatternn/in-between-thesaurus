document.addEventListener('DOMContentLoaded', () => {
    const experience = document.getElementById('experience');
    const constellation = document.getElementById('constellation');
    const strandCanvas = document.getElementById('strand-canvas');
    const wordLayer = document.getElementById('word-layer');
    const transcript = document.getElementById('path-transcript');
    const pathMeta = document.getElementById('path-meta');
    const composer = document.getElementById('composer');
    const tokenList = document.getElementById('token-list');
    const wordInput = document.getElementById('word-input');
    const connectButton = document.getElementById('connect-button');
    const errorOutput = document.getElementById('composer-error');
    const examples = document.getElementById('examples');
    const mockMode = new URLSearchParams(window.location.search).get('mock') === '1';
    const localMode = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

    const colors = {
        start: [185, 130, 255],
        end: [84, 217, 255]
    };

    const mockPaths = new Map([
        ['memory|ocean', {
            nodes: ['memory', 'recollection', 'echo', 'current', 'ocean'],
            mode: 'scenic'
        }],
        ['calm|quiet', {
            nodes: ['calm', 'still', 'quiet'],
            mode: 'synonym'
        }],
        ['fire|ice', {
            nodes: ['fire', 'heat', 'temperature', 'cold', 'ice'],
            mode: 'scenic'
        }],
        ['light|heavy', {
            nodes: ['light', 'slight', 'measured', 'weighty', 'heavy'],
            mode: 'scenic'
        }],
        ['serene|calm', {
            nodes: ['serene', 'calm'],
            mode: 'synonym'
        }]
    ]);

    let tokens = [];
    let activePath = null;
    let activeEdges = [];
    let resizeFrame = null;
    let requestController = null;
    let requestVersion = 0;
    let abortReason = '';
    let timeoutId = null;

    function normalizeWord(value) {
        return value.trim().replace(/[\u2019]/g, "'");
    }

    function isValidWord(value) {
        return /^[\p{L}]+(?:['-][\p{L}]+)*$/u.test(value);
    }

    function showError(message) {
        errorOutput.textContent = message;
    }

    function showMissingKeyError() {
        errorOutput.innerHTML = 'Add your API key in <a href="prompt-lab.html">Prompt Lab</a>, then open the prototype from there.';
    }

    function clearError() {
        errorOutput.textContent = '';
    }

    function setLoading(loading) {
        const label = connectButton.querySelector('span');
        wordInput.disabled = loading;
        connectButton.disabled = false;
        connectButton.classList.toggle('is-cancel', loading);
        connectButton.setAttribute('aria-label', loading ? 'Cancel connection' : 'Connect words');
        label.textContent = loading ? '\u00d7' : '\u2192';
        if (!loading) updateInputState();
    }

    function abortRequest(reason = 'superseded') {
        if (!requestController) return;
        abortReason = reason;
        requestController.abort();
    }

    function updateInputState() {
        if (tokens.length === 0) {
            wordInput.placeholder = 'Type a word, then press space';
        } else if (tokens.length === 1) {
            wordInput.placeholder = 'Now type another word';
        } else {
            wordInput.placeholder = 'Type to restart';
        }

        connectButton.disabled = tokens.length < 2 && wordInput.value.trim() === '';
    }

    function renderTokens() {
        tokenList.replaceChildren();

        tokens.forEach((word, index) => {
            const token = document.createElement('button');
            token.type = 'button';
            token.className = 'token';
            token.textContent = word;
            token.setAttribute('aria-label', `Edit ${word}`);
            token.addEventListener('click', () => editToken(index));
            tokenList.appendChild(token);
        });

        updateInputState();
    }

    function editToken(index) {
        const word = tokens[index];
        if (activePath) {
            resetExperience({ keepFocus: true });
        } else {
            tokens.splice(index, 1);
            renderTokens();
        }
        wordInput.value = word;
        wordInput.focus();
        wordInput.setSelectionRange(word.length, word.length);
        updateInputState();
    }

    function commitWord(rawValue, { autoConnect = true } = {}) {
        const word = normalizeWord(rawValue);

        if (!word) return false;
        if (!isValidWord(word)) {
            showError('Use one word at a time; hyphens and apostrophes are okay.');
            return false;
        }
        if (tokens.length >= 2) {
            showError('Two words are enough for one connection.');
            return false;
        }
        if (tokens.some(token => token.toLocaleLowerCase() === word.toLocaleLowerCase())) {
            showError('Choose two different words.');
            return false;
        }

        clearError();
        tokens.push(word);
        wordInput.value = '';
        renderTokens();

        if (tokens.length === 2 && autoConnect) {
            startConnection();
        }
        return true;
    }

    function pathFor(start, end) {
        const startLower = start.toLocaleLowerCase();
        const endLower = end.toLocaleLowerCase();
        const directKey = `${startLower}|${endLower}`;
        const reverseKey = `${endLower}|${startLower}`;

        if (mockPaths.has(directKey)) {
            return mockPaths.get(directKey);
        }
        if (mockPaths.has(reverseKey)) {
            const match = mockPaths.get(reverseKey);
            return { ...match, nodes: [...match.nodes].reverse() };
        }

        return {
            nodes: [start, 'connection', end],
            mode: 'mock'
        };
    }

    function graphSettings() {
        if (!localMode) return null;
        try {
            if (localStorage.getItem('in-between-connection-strategy') !== 'graph') return null;
            const stored = localStorage.getItem('in-between-graph-settings') ||
                sessionStorage.getItem('in-between-graph-settings');
            return JSON.parse(stored) || null;
        } catch {
            return null;
        }
    }

    function enumerateNeighborhoodTraces(neighborhood) {
        const root = { word: neighborhood.root, key: neighborhood.root.toLocaleLowerCase() };
        const traces = [{ key: root.key, depth: 0, rank: 0, trace: [root] }];
        const firstLevel = new Map();
        const secondLevel = new Map();

        neighborhood.level_1.forEach((word, index) => {
            const node = { word, key: word.toLocaleLowerCase() };
            const entry = { key: node.key, depth: 1, rank: index, trace: [root, node] };
            traces.push(entry);
            if (!firstLevel.has(node.key)) firstLevel.set(node.key, []);
            firstLevel.get(node.key).push(entry);
        });
        neighborhood.level_2.forEach((group, groupIndex) => {
                const parents = firstLevel.get(group.parent.toLocaleLowerCase()) || [];
            parents.forEach(parent => {
                group.children.forEach((word, childIndex) => {
                    const node = { word, key: word.toLocaleLowerCase() };
                    const entry = {
                        key: node.key,
                        depth: 2,
                        rank: groupIndex * 20 + childIndex,
                        trace: [...parent.trace, node]
                    };
                    traces.push(entry);
                    if (!secondLevel.has(node.key)) secondLevel.set(node.key, []);
                    secondLevel.get(node.key).push(entry);
                });
            });
        });
        (neighborhood.level_3 || []).forEach((group, groupIndex) => {
            const parents = secondLevel.get(group.parent.toLocaleLowerCase()) || [];
            parents.forEach(parent => {
                group.children.forEach((word, childIndex) => {
                    const node = { word, key: word.toLocaleLowerCase() };
                    traces.push({
                        key: node.key,
                        depth: 3,
                        rank: groupIndex * 20 + childIndex,
                        trace: [...parent.trace, node]
                    });
                });
            });
        });
        return traces;
    }

    function findNeighborhoodPaths(left, right, preferredIntermediates) {
        const rightByWord = new Map();
        enumerateNeighborhoodTraces(right).forEach(trace => {
            if (!rightByWord.has(trace.key)) rightByWord.set(trace.key, []);
            rightByWord.get(trace.key).push(trace);
        });
        const uniqueRoutes = new Map();

        enumerateNeighborhoodTraces(left).forEach(leftTrace => {
            (rightByWord.get(leftTrace.key) || []).forEach(rightTrace => {
                const intermediates = leftTrace.depth + rightTrace.depth - 1;
                if (intermediates < 1 || intermediates > 5) return;
                const trace = [...leftTrace.trace, ...rightTrace.trace.slice(0, -1).reverse()];
                const keys = trace.map(node => node.key);
                if (new Set(keys).size !== keys.length) return;
                const routeKey = keys.join('|');
                if (uniqueRoutes.has(routeKey)) return;
                const nodes = trace.map(node => node.word);
                uniqueRoutes.set(routeKey, {
                    nodes,
                    edges: nodes.slice(0, -1).map((from, index) => ({
                        from,
                        to: nodes[index + 1],
                        relationship: 'related',
                        shared_sense: ''
                    })),
                    match: leftTrace.key,
                    intermediates,
                    distance: Math.abs(intermediates - preferredIntermediates),
                    rank: leftTrace.rank + rightTrace.rank
                });
            });
        });
        return [...uniqueRoutes.values()].sort((a, b) =>
            a.distance - b.distance || a.rank - b.rank ||
            b.intermediates - a.intermediates || a.match.localeCompare(b.match)
        );
    }

    async function connectFromNeighborhoods(start, end, apiKey, settings, signal) {
        const requestSettings = {
            breadth: settings.breadth,
            depth: settings.depth,
            model: settings.model,
            reasoning: settings.reasoning,
            maxOutputTokens: settings.maxOutputTokens,
            prompt: settings.prompt
        };
        const request = async word => {
            const response = await fetch('/api/neighborhood', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey, word, ...requestSettings }),
                signal
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error?.message || `Neighborhood request failed (${response.status}).`);
            return body;
        };
        const started = performance.now();
        const [left, right] = await Promise.all([request(start), request(end)]);
        const preferredIntermediates = Number(settings.preferredIntermediates);
        const matches = findNeighborhoodPaths(
            left.neighborhood,
            right.neighborhood,
            Number.isFinite(preferredIntermediates) ? preferredIntermediates : 3
        );
        const match = matches[0];
        const latency = Math.round(performance.now() - started);
        try {
            localStorage.setItem('in-between-last-prototype-graph', JSON.stringify({
                start,
                end,
                settings: {
                    ...requestSettings,
                    preferredIntermediates: Number.isFinite(preferredIntermediates) ? preferredIntermediates : 3
                },
                left,
                right,
                latency,
                capturedAt: new Date().toISOString()
            }));
        } catch {
            // The connection result should still render if local inspection storage is unavailable.
        }
        return match ? {
            status: 'path',
            nodes: match.nodes,
            edges: match.edges,
            latency,
            strategy: 'neighborhood'
        } : {
            status: 'no_path',
            nodes: [],
            edges: [],
            latency,
            strategy: 'neighborhood'
        };
    }

    async function startConnection() {
        if (tokens.length !== 2) return;

        if (mockMode) {
            const path = pathFor(tokens[0], tokens[1]);
            activePath = {
                ...path,
                nodes: path.nodes.map((node, index) => {
                    if (index === 0) return tokens[0];
                    if (index === path.nodes.length - 1) return tokens[1];
                    return node;
                })
            };
            activeEdges = [];
            experience.dataset.state = 'result';
            renderPath(activePath, true);
            wordInput.blur();
            return;
        }

        const apiKey = localMode ? sessionStorage.getItem('in-between-openai-key') || '' : '';
        if (localMode && !apiKey) {
            showMissingKeyError();
            return;
        }

        const start = tokens[0];
        const end = tokens[1];
        const settings = graphSettings();
        const thisRequest = ++requestVersion;
        requestController = new AbortController();
        abortReason = '';
        activeEdges = [];
        activePath = { nodes: [start, end], mode: 'searching' };
        experience.dataset.state = 'loading';
        renderPath(activePath, true);
        setLoading(true);
        wordInput.blur();
        timeoutId = window.setTimeout(() => {
            abortReason = 'timeout';
            requestController?.abort();
        }, 30000);

        try {
            let data;
            if (settings?.enabled) {
                data = await connectFromNeighborhoods(start, end, apiKey, settings, requestController.signal);
            } else {
                const response = await fetch('/api/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(localMode ? { start, end, apiKey } : { start, end }),
                    signal: requestController.signal
                });
                data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error?.message || `Connection failed (${response.status}).`);
                }
            }
            if (thisRequest !== requestVersion) return;

            if (data.status === 'no_path') {
                activePath = {
                    nodes: [start, end],
                    mode: 'no_path',
                    strategy: data.strategy || 'path'
                };
                activeEdges = [];
                experience.dataset.state = 'result';
                renderPath(activePath, true);
                return;
            }

            activePath = {
                nodes: data.nodes,
                mode: 'live',
                latency: data.latency,
                strategy: data.strategy || 'path'
            };
            activeEdges = data.edges;
            experience.dataset.state = 'result';
            renderPath(activePath, true);
        } catch (error) {
            if (thisRequest !== requestVersion) return;
            requestController?.abort();
            let message = error.message;
            if (error.name === 'AbortError') {
                message = abortReason === 'timeout' ?
                    'The search took too long. Try again.' : 'Search canceled.';
            }
            activePath = { nodes: [start, end], mode: 'error', message };
            activeEdges = [];
            experience.dataset.state = 'result';
            renderPath(activePath, false);
        } finally {
            if (thisRequest === requestVersion) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
                requestController = null;
                abortReason = '';
                setLoading(false);
            }
        }
    }

    function resetExperience({ keepFocus = false } = {}) {
        requestVersion++;
        abortRequest('superseded');
        window.clearTimeout(timeoutId);
        timeoutId = null;
        requestController = null;
        abortReason = '';
        tokens = [];
        activePath = null;
        activeEdges = [];
        experience.dataset.state = 'idle';
        strandCanvas.replaceChildren();
        wordLayer.replaceChildren();
        transcript.replaceChildren();
        pathMeta.textContent = '';
        clearError();
        setLoading(false);
        renderTokens();
        if (keepFocus) wordInput.focus();
    }

    function interpolateColor(progress, alpha = 1) {
        const values = colors.start.map((channel, index) => {
            return Math.round(channel + (colors.end[index] - channel) * progress);
        });
        return `rgba(${values.join(', ')}, ${alpha})`;
    }

    function createPositions(count, width, height, mobile) {
        const positions = [];
        const edgePadding = mobile ? Math.min(82, height * 0.14) : Math.min(135, width * 0.11);

        for (let index = 0; index < count; index++) {
            const progress = count === 1 ? 0.5 : index / (count - 1);
            const middleWeight = Math.sin(progress * Math.PI);
            const alternating = index % 2 === 0 ? -1 : 1;

            if (mobile) {
                positions.push({
                    x: width / 2 + alternating * middleWeight * Math.min(58, width * 0.14),
                    y: edgePadding + progress * (height - edgePadding * 2)
                });
            } else {
                positions.push({
                    x: edgePadding + progress * (width - edgePadding * 2),
                    y: height / 2 + alternating * middleWeight * Math.min(88, height * 0.18)
                });
            }
        }
        return positions;
    }

    function edgePath(from, to, mobile) {
        if (mobile) {
            const controlY = (from.y + to.y) / 2;
            return `M ${from.x} ${from.y} C ${from.x} ${controlY}, ${to.x} ${controlY}, ${to.x} ${to.y}`;
        }
        const controlX = (from.x + to.x) / 2;
        return `M ${from.x} ${from.y} C ${controlX} ${from.y}, ${controlX} ${to.y}, ${to.x} ${to.y}`;
    }

    function revealDelay(index, total, type) {
        const lastIndex = type === 'edge' ? total - 2 : total - 1;
        const wave = Math.min(index, lastIndex - index);
        const base = type === 'edge' ? 0.34 : 0.12;
        return `${base + wave * 0.58}s`;
    }

    function renderPath(path, animate) {
        const bounds = constellation.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;

        const mobile = window.matchMedia('(max-width: 700px)').matches;
        const positions = createPositions(path.nodes.length, bounds.width, bounds.height, mobile);
        const namespace = 'http://www.w3.org/2000/svg';

        strandCanvas.replaceChildren();
        wordLayer.replaceChildren();
        transcript.replaceChildren();
        strandCanvas.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);

        const defs = document.createElementNS(namespace, 'defs');
        strandCanvas.appendChild(defs);

        const showStrand = !['no_path', 'error'].includes(path.mode);
        if (showStrand) positions.slice(0, -1).forEach((position, index) => {
            const gradient = document.createElementNS(namespace, 'linearGradient');
            const gradientId = `strand-gradient-${index}`;
            gradient.id = gradientId;
            gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
            gradient.setAttribute('x1', position.x);
            gradient.setAttribute('y1', position.y);
            gradient.setAttribute('x2', positions[index + 1].x);
            gradient.setAttribute('y2', positions[index + 1].y);

            const startStop = document.createElementNS(namespace, 'stop');
            startStop.setAttribute('offset', '0%');
            startStop.setAttribute('stop-color', interpolateColor(index / (positions.length - 1)));
            gradient.appendChild(startStop);

            const endStop = document.createElementNS(namespace, 'stop');
            endStop.setAttribute('offset', '100%');
            endStop.setAttribute('stop-color', interpolateColor((index + 1) / (positions.length - 1)));
            gradient.appendChild(endStop);
            defs.appendChild(gradient);

            const strand = document.createElementNS(namespace, 'path');
            strand.classList.add('strand');
            if (!animate) strand.classList.add('no-animation');
            strand.setAttribute('d', edgePath(position, positions[index + 1], mobile));
            strand.setAttribute('stroke', `url(#${gradientId})`);
            strand.style.setProperty('--delay', animate ? revealDelay(index, positions.length, 'edge') : '0s');
            strand.style.setProperty('--strand-glow', interpolateColor((index + 0.5) / (positions.length - 1), 0.55));
            strandCanvas.appendChild(strand);

            const length = strand.getTotalLength();
            strand.style.strokeDasharray = `${length}`;
            strand.style.setProperty('--path-length', `${animate ? length : 0}`);
        });

        path.nodes.forEach((word, index) => {
            const progress = index / (path.nodes.length - 1);
            const node = document.createElement('div');
            node.className = 'word-node';
            if (!animate) node.classList.add('no-animation');
            if (index === 0 || index === path.nodes.length - 1) {
                node.classList.add('is-anchor');
            }
            node.style.left = `${positions[index].x}px`;
            node.style.top = `${positions[index].y}px`;
            node.style.setProperty('--node-color', interpolateColor(progress));
            node.style.setProperty('--node-glow', interpolateColor(progress, 0.32));
            node.style.setProperty('--delay', animate ? revealDelay(index, path.nodes.length, 'node') : '0s');
            node.style.setProperty('--breathe-delay', `${-index * 0.9}s`);

            const inner = document.createElement('span');
            inner.className = 'word-node-inner';
            inner.textContent = word;
            node.appendChild(inner);
            wordLayer.appendChild(node);

            const transcriptItem = document.createElement('li');
            transcriptItem.textContent = word;
            transcript.appendChild(transcriptItem);
        });

        if (path.mode === 'searching') {
            pathMeta.textContent = 'Searching from both words';
        } else if (path.mode === 'live') {
            const prefix = path.strategy === 'neighborhood' ? 'Neighborhood match' : 'Connected';
            pathMeta.textContent = path.latency ? `${prefix} in ${(path.latency / 1000).toFixed(1)} seconds` : prefix;
        } else if (path.mode === 'no_path') {
            pathMeta.textContent = path.strategy === 'neighborhood' ?
                'No neighborhood overlap found. Try another pair.' : 'No strict path found. Try another pair.';
        } else if (path.mode === 'error') {
            pathMeta.textContent = path.message;
        } else if (path.mode === 'scenic') {
            pathMeta.innerHTML = 'Mock path <span aria-hidden="true">&middot;</span> <span class="scenic">taking the scenic route</span>';
        } else if (path.mode === 'synonym') {
            pathMeta.textContent = 'Mock synonym path';
        } else {
            pathMeta.textContent = 'Mock connection - LLM not connected';
        }
    }

    composer.addEventListener('submit', event => {
        event.preventDefault();
        if (experience.dataset.state === 'loading') {
            abortRequest('manual');
            return;
        }
        if (activePath && wordInput.value.trim()) {
            resetExperience({ keepFocus: true });
        }
        if (wordInput.value.trim()) {
            commitWord(wordInput.value);
        } else if (tokens.length === 2) {
            startConnection();
        }
    });

    wordInput.addEventListener('keydown', event => {
        const commitsWord = event.key === 'Enter' || event.key === ' ';

        if (activePath && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            resetExperience({ keepFocus: true });
        }

        if (commitsWord) {
            event.preventDefault();
            commitWord(wordInput.value);
            return;
        }

        if (event.key === 'Backspace' && wordInput.value === '' && tokens.length > 0) {
            event.preventDefault();
            if (activePath) {
                resetExperience({ keepFocus: true });
            } else {
                wordInput.value = tokens.pop();
                renderTokens();
            }
        }
    });

    wordInput.addEventListener('input', () => {
        clearError();
        updateInputState();
    });

    wordInput.addEventListener('paste', event => {
        const pasted = event.clipboardData.getData('text').trim();
        const pastedWords = pasted.split(/\s+/).filter(Boolean);
        if (pastedWords.length < 2) return;

        event.preventDefault();
        if (activePath) resetExperience({ keepFocus: true });
        if (pastedWords.length > 2) {
            showError('Paste exactly two words.');
            return;
        }

        const firstCommitted = commitWord(pastedWords[0], { autoConnect: false });
        if (firstCommitted) commitWord(pastedWords[1]);
    });

    examples.addEventListener('click', event => {
        const button = event.target.closest('[data-pair]');
        if (!button) return;
        const pair = button.dataset.pair.split(' ');
        resetExperience();
        tokens = pair;
        renderTokens();
        startConnection();
    });

    window.addEventListener('resize', () => {
        if (!activePath) return;
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => renderPath(activePath, false));
    });

    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && experience.dataset.state === 'loading') {
            event.preventDefault();
            abortRequest('manual');
        }
    });

    renderTokens();
});
