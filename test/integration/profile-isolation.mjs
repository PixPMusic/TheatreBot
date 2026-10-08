// Run only inside a disposable Linux container with Xvfb and PulseAudio.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { initDriver, closeDriver } from '../../dist/browser/driver.js';
import config from '../../dist/config.js';
import logger from '../../dist/utils/logger.js';
logger.silent = true;
const A = '111111111111111111', B = '222222222222222222';
let hangingRequest = false;
const web = createServer((req, res) => {
    if (req.url === '/hang') { hangingRequest = true; return; }
    res.setHeader('Content-Type', req.url === '/worker.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/worker.js' ? "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" : '<!doctype html><title>Profile isolation fixture</title><body>Local fixture</body>');
});
await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
config.browser.defaultUrl = `http://127.0.0.1:${web.address().port}/`;
config.browser.profileRoot = '/tmp/theatrebot-profiletest-profiles';
await rm(config.browser.profileRoot, { recursive: true, force: true });
const windows = () => JSON.parse(execFileSync('python3', ['-c', `
import ctypes,json,os
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryTree.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),ctypes.POINTER(ctypes.c_uint)]
x.XCloseDisplay.argtypes=[ctypes.c_void_p]
d=x.XOpenDisplay(os.environ['DISPLAY'].encode());assert d
root=ctypes.c_ulong();parent=ctypes.c_ulong();children=ctypes.POINTER(ctypes.c_ulong)();count=ctypes.c_uint()
assert x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(root),ctypes.byref(parent),ctypes.byref(children),ctypes.byref(count))
print(json.dumps(sorted(children[i] for i in range(count.value))))
x.XFree(children);x.XCloseDisplay(d)
`], { encoding: 'utf8' }));
const baselineWindows = windows();
const sinks = () => execFileSync('pactl', ['list', 'short', 'sink-inputs'], { encoding: 'utf8' }).trim();
const script = async (driver, mode, owner) => driver.executeAsyncScript(function(mode, owner, done) {
    (async () => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('theatrebot-profiletest', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('storage');
            open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        if (mode === 'write') {
            document.cookie = `owner=${owner}; Max-Age=86400; SameSite=Lax`;
            localStorage.setItem('owner', owner);
            await new Promise((resolve, reject) => { const tx = db.transaction('storage', 'readwrite'); tx.objectStore('storage').put(owner, 'owner'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
            await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;
            await (await caches.open('owner')).put('/owner', new Response(owner));
            window.audio = new AudioContext(); window.oscillator = audio.createOscillator(); oscillator.connect(audio.destination); oscillator.start();
        }
        const idb = await new Promise((resolve, reject) => { const get = db.transaction('storage').objectStore('storage').get('owner'); get.onsuccess = () => resolve(get.result ?? null); get.onerror = () => reject(get.error); });
        const cached = await (await caches.open('owner')).match('/owner');
        const registrations = await navigator.serviceWorker.getRegistrations();
        return { cookie: document.cookie, local: localStorage.getItem('owner'), idb, serviceWorkers: registrations.length, cache: cached ? await cached.text() : null };
    })().then(done, error => done({ error: String(error) }));
}, mode, owner);
async function processGone(pid) {
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z'; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function closed(driver, failedQuit = false) {
    const pid = (await driver.getCapabilities()).get('goog:processID');
    if (failedQuit) driver.quit = async () => { throw new Error('Injected QUIT transport failure'); };
    assert.notDeepEqual(windows(), baselineWindows);
    await closeDriver(); assert.equal(await processGone(pid), true); assert.equal(sinks(), ''); assert.deepEqual(windows(), baselineWindows);
    return { browserPidExited: true, pulseAudioInputsEmpty: true, x11WindowsGone: true, failedQuit };
}
try {
    let driver = await initDriver(A);
    const version = (await driver.getCapabilities()).get('browserVersion');
    assert.equal((await driver.getCapabilities()).get('chrome').userDataDir, `${config.browser.profileRoot}/${A}`);
    const first = await script(driver, 'write', A); assert.equal(first.local, A); assert.equal(first.idb, A); assert.equal(first.serviceWorkers, 1); assert.equal(first.cache, A);
    // Wait only for the audio input to become visible, bounded to two seconds.
    for (const deadline = Date.now() + 2000; !sinks() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    assert.notEqual(sinks(), '');
    const normalExit = await closed(driver);
    driver = await initDriver(B);
    const isolated = await script(driver, 'read'); assert.deepEqual(isolated, { cookie: '', local: null, idb: null, serviceWorkers: 0, cache: null });
    await script(driver, 'write', B); const failureExit = await closed(driver, true);
    driver = await initDriver(A);
    const restored = await script(driver, 'read'); assert.equal(restored.cookie, `owner=${A}`); assert.equal(restored.local, A); assert.equal(restored.idb, A); assert.equal(restored.serviceWorkers, 1); assert.equal(restored.cache, A);
    const finalExit = await closed(driver);
    config.browser.defaultUrl = `http://127.0.0.1:${web.address().port}/hang`;
    const hung = initDriver(A), cancelled = assert.rejects(hung, /initialization cancelled/);
    for (const deadline = Date.now() + 5000; !hangingRequest && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(hangingRequest, true);
    const cancelStarted = Date.now(); await closeDriver(); await cancelled;
    const hungNavigationCancellationMs = Date.now() - cancelStarted;
    assert.ok(hungNavigationCancellationMs < 15000); assert.equal(sinks(), ''); assert.deepEqual(windows(), baselineWindows);
    web.closeAllConnections();
    console.log(JSON.stringify({ hungNavigationCancellationMs, chromium: version, A_to_B_isolation: isolated, A_to_A_persistence: restored, normalExit, failureExit, finalExit }));
} finally { await closeDriver(); await new Promise(resolve => web.close(resolve)); }
