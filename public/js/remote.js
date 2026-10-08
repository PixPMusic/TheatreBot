/**
 * Theatre Bot - Remote Control JavaScript
 */

// State
let socket = null;
let currentPreset = null;
let presets = [];
let csrf = null;
let capabilities = { control: false, navigate: false };
const authMessage = document.getElementById('auth-message');
const loginLink = document.getElementById('login-link');
const logoutBtn = document.getElementById('logout-btn');
const controls = document.getElementById('controls');

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
    setupEventListeners();
    logoutBtn.addEventListener('click', async () => {
        try {
            await api('/auth/logout', { method: 'POST' });
            signedOut('Signed out. Sign in with Discord to control a stream.');
        } catch (error) { authMessage.textContent = error.message; }
    });
    await updateAccess();
    setInterval(updateAccess, 10000);
}

function signedOut(message) {
    csrf = null;
    capabilities = { control: false, navigate: false };
    if (socket) { socket.disconnect(); socket = null; }
    controls.inert = true;
    loginLink.hidden = false;
    logoutBtn.hidden = true;
    authMessage.textContent = message;
    urlDisplay.value = '';
    sessionInfo.textContent = 'None';
    presetGrid.replaceChildren();
    statusText.textContent = 'Sign in required';
    statusDot.classList.remove('connected');
    statusDot.classList.add('disconnected');
}

async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.method === 'POST') headers['X-CSRF-Token'] = csrf;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) signedOut('Your login expired. Sign in with Discord again.');
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
    }
    return response;
}

async function updateAccess() {
    try {
        const response = await fetch('/api/auth/session');
        if (!response.ok) throw new Error('Unable to check Discord login');
        const data = await response.json();
        if (!data.authenticated) { signedOut('Sign in with Discord to control a stream.'); return; }
        csrf = data.csrf;
        capabilities = data.capabilities;
        loginLink.hidden = true;
        logoutBtn.hidden = false;
        authMessage.textContent = data.accessError || `Signed in as ${data.user.username}`;
        controls.inert = !capabilities.control && !capabilities.navigate;
        document.querySelectorAll('[data-key], #search-btn, #refresh-btn, #back-history-btn, .preset-btn').forEach(button => { button.disabled = !capabilities.control; });
        goBtn.disabled = !capabilities.navigate;
        urlInput.disabled = !capabilities.navigate;
        if (controls.inert) {
            if (socket) { socket.disconnect(); socket = null; }
            urlDisplay.value = ''; sessionInfo.textContent = 'None';
            statusText.textContent = data.accessStatus === 503 ? 'Verification delayed' : 'Permission required';
            statusDot.classList.remove('connected');
            statusDot.classList.add('disconnected');
            return;
        }
        if (!socket) connectSocket();
        await loadPresets();
        await loadStatus();
    } catch (error) {
        controls.inert = true;
        if (socket) { socket.disconnect(); socket = null; }
        authMessage.textContent = error.message;
    }
}

// Socket.IO Connection
function connectSocket() {
    socket = io({ auth: { csrf } });
    
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
    
    socket.on('error', ({ message }) => { authMessage.textContent = message; updateAccess(); });
    socket.on('connect_error', error => { authMessage.textContent = error.message; });
}

// Load status from API
async function loadStatus() {
    try {
        const response = await api('/api/status');
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
        const response = await api('/api/presets');
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
    presetGrid.replaceChildren(...presets.map(preset => {
        const button = document.createElement('button');
        button.className = 'preset-btn';
        button.dataset.presetId = preset.id;
        button.disabled = !capabilities.control;
        const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = preset.icon || '🔗';
        const label = document.createElement('span'); label.textContent = preset.name;
        button.append(icon, label);
        return button;
    }));

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
        if (capabilities.control && socket?.connected) socket.emit('preset', presetId);
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
    if (!capabilities.control || !socket?.connected) return;
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
    if (capabilities.navigate && socket?.connected) socket.emit('navigate', url);
}

// Search
function search(query, submit = false) {
    if (capabilities.control && socket?.connected) socket.emit('search', { query, submit });
}

// Refresh page
async function refresh() {
    try {
        await api('/api/refresh', { method: 'POST' });
    } catch (error) {
        authMessage.textContent = error.message;
    }
}

// Go back in history
async function goBack() {
    try {
        await api('/api/back', { method: 'POST' });
    } catch (error) {
        authMessage.textContent = error.message;
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
