/**
 * Theatre Bot - Remote Control JavaScript
 */

// State
let socket = null;
let currentPreset = null;
let presets = [];

// DOM Elements
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('status-text');
const urlDisplay = document.getElementById('url-display');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const refreshBtn = document.getElementById('refresh-btn');
const presetGrid = document.getElementById('preset-grid');
const searchSection = document.getElementById('search-section');
const searchLabel = document.getElementById('search-label');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const backHistoryBtn = document.getElementById('back-history-btn');
const sessionInfo = document.getElementById('session-info');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
    // Connect to Socket.IO
    connectSocket();
    
    // Load presets
    await loadPresets();
    
    // Setup event listeners
    setupEventListeners();
    
    // Load initial status
    await loadStatus();
}

// Socket.IO Connection
function connectSocket() {
    socket = io();
    
    socket.on('connect', () => {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
    });
    
    socket.on('disconnect', () => {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
    });
    
    socket.on('urlChanged', ({ url }) => {
        urlDisplay.value = url;
        detectPresetFromUrl(url);
    });
    
    socket.on('presetChanged', ({ preset }) => {
        setActivePreset(preset);
    });
    
    socket.on('error', ({ message }) => {
        console.error('Socket error:', message);
    });
}

// Load status from API
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        if (data.browser?.currentUrl) {
            urlDisplay.value = data.browser.currentUrl;
            detectPresetFromUrl(data.browser.currentUrl);
        }
        
        if (data.sessions?.length > 0) {
            const session = data.sessions[0];
            sessionInfo.textContent = `${session.guildId}/${session.channelId}`;
        }
    } catch (error) {
        console.error('Failed to load status:', error);
    }
}

// Load presets from API
async function loadPresets() {
    try {
        const response = await fetch('/api/presets');
        presets = await response.json();
        renderPresets();
    } catch (error) {
        console.error('Failed to load presets:', error);
        // Use default presets
        presets = [
            { id: 'youtube-tv', name: 'YouTube TV', icon: '📺' },
            { id: 'plex', name: 'Plex', icon: '🎬' },
        ];
        renderPresets();
    }
}

// Render presets
function renderPresets() {
    presetGrid.innerHTML = presets.map(preset => `
        <button class="preset-btn" data-preset-id="${preset.id}">
            <span class="icon">${preset.icon || '🔗'}</span>
            <span>${preset.name}</span>
        </button>
    `).join('');
    
    // Add click handlers
    presetGrid.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const presetId = btn.dataset.presetId;
            navigateToPreset(presetId);
        });
    });
}

// Detect preset from URL
function detectPresetFromUrl(url) {
    for (const preset of presets) {
        if (preset.url && url.includes(new URL(preset.url).hostname)) {
            setActivePreset(preset);
            return;
        }
    }
    setActivePreset(null);
}

// Set active preset (update UI)
function setActivePreset(preset) {
    currentPreset = preset;
    
    // Update preset buttons
    presetGrid.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', preset && btn.dataset.presetId === preset.id);
    });
    
    // Show/hide search section
    if (preset?.searchSelector) {
        searchSection.style.display = 'block';
        searchLabel.textContent = `Search ${preset.name}`;
        searchInput.placeholder = `Search ${preset.name}...`;
    } else {
        searchSection.style.display = 'none';
    }
}

// Navigate to preset
async function navigateToPreset(presetId) {
    try {
        socket.emit('preset', presetId);
    } catch (error) {
        console.error('Failed to navigate to preset:', error);
    }
}

// Setup event listeners
function setupEventListeners() {
    // D-pad and control buttons
    document.querySelectorAll('[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            sendKey(key);
        });
    });
    
    // URL navigation
    goBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (url) {
            navigate(url);
        }
    });
    
    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            goBtn.click();
        }
    });
    
    // Refresh
    refreshBtn.addEventListener('click', refresh);
    
    // Back history
    backHistoryBtn.addEventListener('click', goBack);
    
    // Search
    searchBtn.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query) {
            search(query, true);
            searchInput.value = '';
        }
    });
    
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);
}

// Send key to browser
function sendKey(key) {
    socket.emit('key', key);
    
    // Visual feedback
    const btn = document.querySelector(`[data-key="${key}"]`);
    if (btn) {
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => {
            btn.style.transform = '';
        }, 100);
    }
}

// Navigate to URL
function navigate(url) {
    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    socket.emit('navigate', url);
}

// Search
function search(query, submit = false) {
    socket.emit('search', { query, submit });
}

// Refresh page
async function refresh() {
    try {
        await fetch('/api/refresh', { method: 'POST' });
    } catch (error) {
        console.error('Refresh failed:', error);
    }
}

// Go back in history
async function goBack() {
    try {
        await fetch('/api/back', { method: 'POST' });
    } catch (error) {
        console.error('Back failed:', error);
    }
}

// Handle keyboard shortcuts for remote control
function handleKeyboard(e) {
    // Don't intercept if typing in an input
    if (e.target.tagName === 'INPUT') {
        return;
    }
    
    const keyMap = {
        'ArrowUp': 'ArrowUp',
        'ArrowDown': 'ArrowDown',
        'ArrowLeft': 'ArrowLeft',
        'ArrowRight': 'ArrowRight',
        'Enter': 'Enter',
        'Escape': 'Escape',
        'Backspace': 'Escape',
        ' ': 'Space',
    };
    
    const mappedKey = keyMap[e.key];
    if (mappedKey) {
        e.preventDefault();
        sendKey(mappedKey);
    }
}
