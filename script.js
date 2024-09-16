// script.js

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('search-input');
    const searchButton = document.getElementById('search-button');
    const clearButton = document.getElementById('clear-button');
    const tilesContainer = document.getElementById('tiles-container');
    const tokensContainer = document.getElementById('tokens-container');

    // Predefined list of distinct colors
    const colorPalette = [
        '#1f77b4', // Blue
        '#ff7f0e', // Orange
        '#2ca02c', // Green
        '#d62728', // Red
        '#9467bd', // Purple
        '#8c564b', // Brown
        '#e377c2', // Pink
        '#7f7f7f', // Gray
        '#bcbd22', // Olive
        '#17becf'  // Cyan
    ];

    let tokenColorMap = {}; // Maps token to its assigned color
    let synonymMap = {};    // Maps synonym to Set of tokens it belongs to
    let usedColors = 0;     // Tracks the number of colors used

    // Event listener for the search button
    searchButton.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query !== '') {
            processInput(query);
        }
    });

    // Event listener for pressing 'Enter' key in the input
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query !== '') {
                processInput(query);
            }
        }
    });

    // Event listener for the clear button
    clearButton.addEventListener('click', () => {
        clearAll();
    });

    // Function to process the input
    async function processInput(input) {
        const tokens = input.split(/\s+/);
        console.log('Processing input tokens:', tokens);
        tilesContainer.innerHTML = ''; // Clear existing tiles
        tokensContainer.innerHTML = ''; // Clear existing tokens
        synonymMap = {}; // Reset synonym mapping
        tokenColorMap = {}; // Reset token-color mapping
        usedColors = 0; // Reset color usage

        // Assign colors and display tokens
        tokens.forEach(token => {
            assignColorToToken(token);
            displayToken(token);
        });

        console.log('Assigned Token Colors:', tokenColorMap);

        // Fetch synonyms for all tokens in parallel
        const fetchPromises = tokens.map(token => fetchSynonyms(token));
        await Promise.all(fetchPromises);

        console.log('Synonym Map after fetching all synonyms:', synonymMap);

        // After all synonyms are fetched, create tiles
        createSynonymTiles();
    }

    // Function to assign a unique color to each token
    function assignColorToToken(token) {
        const tokenLower = token.toLowerCase();
        if (!tokenColorMap[tokenLower]) { // Case-insensitive
            tokenColorMap[tokenLower] = colorPalette[usedColors % colorPalette.length];
            usedColors++;
        }
    }

    // Function to display tokens as colored labels
    function displayToken(token) {
        const tokenDiv = document.createElement('div');
        tokenDiv.classList.add('token');
        tokenDiv.style.backgroundColor = tokenColorMap[token.toLowerCase()];
        tokenDiv.textContent = token;
        tokensContainer.appendChild(tokenDiv);
    }

    // Function to fetch synonyms using Datamuse API
    async function fetchSynonyms(word) {
        console.log(`Fetching synonyms for: "${word}"`);
        try {
            const response = await fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&max=10`);
            if (!response.ok) {
                throw new Error(`Error fetching synonyms for "${word}": ${response.statusText}`);
            }
            const data = await response.json();
            console.log(`Synonyms for "${word}":`, data);
            mapSynonyms(word, data);
        } catch (error) {
            console.error(error);
            displayError(`Failed to fetch synonyms for "${word}"`);
        }
    }

    // Function to map synonyms to their associated tokens
    function mapSynonyms(originalWord, synonyms) {
        const originalWordLower = originalWord.toLowerCase();
        synonyms.forEach(syn => {
            const synLower = syn.word.toLowerCase();
            if (!synonymMap[synLower]) {
                synonymMap[synLower] = new Set();
            }
            synonymMap[synLower].add(originalWordLower);
        });
        console.log(`Mapped synonyms for "${originalWord}":`, synonyms.map(s => s.word));
    }

    // Function to create synonym tiles based on the synonymMap
    function createSynonymTiles() {
        // Iterate through synonymMap to create tiles
        Object.keys(synonymMap).forEach(syn => {
            const associatedTokens = Array.from(synonymMap[syn]);
            console.log(`Creating tile for synonym "${syn}" associated with tokens:`, associatedTokens);
            if (associatedTokens.length === 1) {
                // Single token synonym
                const token = associatedTokens[0];
                const color = tokenColorMap[token];
                const tile = createTile(syn, false, [color]);
                tilesContainer.appendChild(tile);
            } else if (associatedTokens.length > 1) {
                // Common synonym
                const colors = associatedTokens.map(token => tokenColorMap[token]);
                console.log(`Synonym "${syn}" is common to colors:`, colors);
                const tile = createTile(syn, false, colors);
                tilesContainer.appendChild(tile);
            }
        });
    }

    // Function to create a tile element
    function createTile(word, isNoSyn = false, colors = []) {
        const tile = document.createElement('div');
        tile.classList.add('tile');

        if (isNoSyn) {
            tile.classList.add('no-synonym');
            tile.textContent = word;
        } else if (colors.length === 1) {
            // Single color
            tile.style.backgroundColor = colors[0];
            tile.textContent = word;
            tile.addEventListener('click', () => {
                addWordToSearch(word);
            });
        } else if (colors.length > 1) {
            // Multiple colors - create a split gradient
            const gradient = generateGradient(colors);
            tile.style.background = gradient;
            tile.textContent = word;
            tile.addEventListener('click', () => {
                addWordToSearch(word);
            });
        }

        return tile;
    }

    // Function to generate linear-gradient CSS string based on colors
    function generateGradient(colors) {
        const segmentPercentage = 100 / colors.length;
        let gradientString = 'linear-gradient(to right';
        colors.forEach((color, index) => {
            const start = index * segmentPercentage;
            const end = (index + 1) * segmentPercentage;
            gradientString += `, ${color} ${start}%, ${color} ${end}%`;
        });
        gradientString += ')';
        console.log(`Generated gradient for colors [${colors.join(', ')}]:`, gradientString);
        return gradientString;
    }

    // Function to add a word to the search input and re-fetch synonyms
    function addWordToSearch(word) {
        const currentInput = searchInput.value.trim();
        const words = currentInput.split(/\s+/).map(w => w.toLowerCase());
        if (!words.includes(word.toLowerCase())) {
            searchInput.value = currentInput === '' ? word : `${currentInput} ${word}`;
            processInput(searchInput.value);
        }
    }

    // Function to display error messages on the UI
    function displayError(message) {
        const errorTile = createTile(message, true);
        tilesContainer.appendChild(errorTile);
    }

    // Function to clear the input, tokens, and tiles
    function clearAll() {
        searchInput.value = '';
        tokensContainer.innerHTML = '';
        tilesContainer.innerHTML = '';
        tokenColorMap = {};
        synonymMap = {};
        usedColors = 0;
        console.log('Cleared all tokens and tiles.');
    }
});
