import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Builder, WebDriver, Session, error } from "selenium-webdriver";
import { Name } from "selenium-webdriver/lib/command.js";
import { initDriver, getDriver, closeDriver } from "../dist/browser/driver.js";
import config from "../dist/config.js";
import logger from "../dist/utils/logger.js";

import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserProcess } from "../dist/browser/processes.js";
const OWNER = "123456789012345678";
let profileRoot;
beforeEach(async t => {
    profileRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "theatrebot-profiletest-"));
    config.browser.profileRoot = profileRoot;
    t.mock.method(BrowserProcess, "launch", async () => ({ url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: async () => {} }));
    t.after(() => rm(profileRoot, { recursive: true, force: true }));
});
logger.silent = true;
afterEach(closeDriver);

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function candidate({ get = async () => {}, quit = async () => {} } = {}) {
    const browser = { urls: [], quits: 0 };
    browser.getCapabilities = async () => new Map([["goog:processID", 999999]]);
    browser.get = async url => { browser.urls.push(url); await get(url); };
    browser.quit = async () => { browser.quits++; await quit(); };
    return browser;
}

function seleniumCandidate(t, { get = async () => {}, quit = async () => {}, onQuit = () => {} } = {}) {
    const commands = [];
    const onQuitCall = t.mock.fn(onQuit);
    const driver = new WebDriver(new Session("test-session", {}), {
        execute: async command => {
            const name = command.getName();
            commands.push(name);
            if (name === Name.GET) return get();
            if (name === Name.QUIT) return quit();
            throw new Error(`Unexpected Selenium command: ${name}`);
        },
    }, onQuitCall);
    const quitCall = t.mock.method(driver, "quit");
    return { driver, commands, onQuit: onQuitCall, quitCall };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 50));

test("concurrent startup shares build and navigation and publishes only a ready driver", async t => {
    const built = deferred(), navigated = deferred();
    const browser = candidate({ get: () => navigated.promise });
    const build = t.mock.method(Builder.prototype, "build", () => built.promise);
    const first = initDriver(OWNER), second = initDriver(OWNER);
    assert.equal(first, second);
    assert.equal(getDriver(), null);
    await flush();
    assert.equal(build.mock.callCount(), 1);
    built.resolve(browser);
    await flush();
    assert.deepEqual(browser.urls, [config.browser.defaultUrl]);
    assert.equal(getDriver(), null);
    assert.equal(initDriver(OWNER), first);
    navigated.resolve();
    assert.equal(await first, browser);
    assert.equal(await second, browser);
    assert.equal(getDriver(), browser);
    assert.equal(await initDriver(OWNER), browser);
    assert.equal(build.mock.callCount(), 1);
});

for (const synchronous of [true, false]) {
    test(`${synchronous ? "synchronous" : "asynchronous"} build failure clears pending startup and allows retry`, async t => {
        const failure = new Error("build failed");
        const browser = candidate();
        let builds = 0;
        t.mock.method(Builder.prototype, "build", () => {
            if (++builds > 1) return Promise.resolve(browser);
            if (synchronous) throw failure;
            return Promise.reject(failure);
        });
        const first = initDriver(OWNER), second = initDriver(OWNER);
        await assert.rejects(first, error => error === failure);
        await assert.rejects(second, error => error === failure);
        assert.equal(getDriver(), null);
        assert.equal(await initDriver(OWNER), browser);
        assert.equal(builds, 2);
    });
}

test("navigation failure disposes its candidate once before retry can build", async t => {
    const disposal = deferred();
    const failure = new Error("navigation failed");
    const failed = candidate({ get: async () => { throw failure; }, quit: () => disposal.promise });
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        Promise.resolve(++builds === 1 ? failed : replacement));
    const startup = initDriver(OWNER);
    const rejected = assert.rejects(startup, error => error === failure);
    await flush();
    assert.equal(getDriver(), null);
    assert.equal(failed.quits, 1);
    assert.equal(initDriver(OWNER), startup);
    assert.equal(build.mock.callCount(), 1);
    disposal.resolve();
    await rejected;
    assert.equal(await initDriver(OWNER), replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(failed.quits, 1);
});

test("close during build cancels late publication and delays replacement until disposal", async t => {
    const built = deferred(), disposal = deferred();
    const old = candidate();
    const replacement = candidate();
    let launches = 0;
    t.mock.method(BrowserProcess, "launch", async () => ({ url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: ++launches === 1 ? () => disposal.promise : async () => {} }));
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        ++builds === 1 ? built.promise : Promise.resolve(replacement));
    const startup = initDriver(OWNER);
    const cancelled = assert.rejects(startup, /initialization cancelled/);
    await flush();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    const restart = initDriver(OWNER), otherRestart = initDriver(OWNER);
    built.resolve(old);
    await flush();
    assert.equal(getDriver(), null);
    assert.deepEqual(old.urls, []);
    assert.equal(old.quits, 1);
    assert.equal(build.mock.callCount(), 1);
    disposal.resolve();
    await cancelled;
    await close;
    assert.equal(await restart, replacement);
    assert.equal(await otherRestart, replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(old.quits, 1);
});

for (const fails of [false, true]) {
    test(`close during ${fails ? "failing" : "successful"} navigation prevents late publication`, async t => {
        const navigation = deferred();
        const browser = candidate({ get: () => navigation.promise });
        t.mock.method(Builder.prototype, "build", () => Promise.resolve(browser));
        const startup = initDriver(OWNER);
        const rejected = assert.rejects(startup, /initialization cancelled/);
        await flush();
        assert.deepEqual(browser.urls, [config.browser.defaultUrl]);
        const close = closeDriver();
        assert.equal(getDriver(), null);
        if (fails) navigation.reject(new Error("navigation failed"));
        else navigation.resolve();
        await rejected;
        await close;
        assert.equal(getDriver(), null);
        assert.equal(browser.quits, 1);
        await closeDriver();
        assert.equal(browser.quits, 1);
    });
}

test("closing a ready driver is idempotent and delays a replacement until quit settles", async t => {
    const disposal = deferred();
    const old = candidate({ quit: () => disposal.promise }), replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        Promise.resolve(++builds === 1 ? old : replacement));
    await initDriver(OWNER);
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    assert.equal(getDriver(), null);
    const restart = initDriver(OWNER);
    await flush();
    assert.equal(old.quits, 1);
    assert.equal(build.mock.callCount(), 1);
    disposal.resolve();
    await close;
    assert.equal(await restart, replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(old.quits, 1);
    await closeDriver();
    await closeDriver();
    assert.equal(replacement.quits, 1);
});

test("immediate close cancels a queued startup before building", async t => {
    const build = t.mock.method(Builder.prototype, "build", () => { throw new Error("must not build"); });
    const startup = initDriver(OWNER);
    const rejected = assert.rejects(startup, /initialization cancelled/);
    await closeDriver();
    await rejected;
    assert.equal(getDriver(), null);
    assert.equal(build.mock.callCount(), 0);
});

test("failed quit never retries a spent Selenium handle and process cleanup gates replacement", async t => {
    const old = seleniumCandidate(t, { quit: async () => { throw new Error("quit failed"); } });
    const replacement = candidate();
    let processesClosed = 0, builds = 0;
    t.mock.method(BrowserProcess, "launch", async () => ({ url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: async () => { processesClosed++; } }));
    t.mock.method(Builder.prototype, "build", async () => ++builds === 1 ? old.driver : replacement);
    await initDriver(OWNER);
    await closeDriver();
    assert.equal(processesClosed, 1);
    assert.equal(old.quitCall.mock.callCount(), 1);
    await assert.rejects(old.driver.getSession(), error.NoSuchSessionError);
    assert.equal(await initDriver(OWNER), replacement);
});

test("a failed process exit barrier keeps profile leased and replacement blocked until cleanup retry", async t => {
    let fail = true, quits = 0, builds = 0;
    const old = candidate({ quit: async () => { quits++; } });
    t.mock.method(BrowserProcess, "launch", async () => ({ url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: async () => { if (fail) throw new Error("still running"); } }));
    t.mock.method(Builder.prototype, "build", async () => { builds++; return old; });
    await initDriver(OWNER);
    await assert.rejects(closeDriver(), /still running/);
    await assert.rejects(initDriver(OWNER), /cleanup is incomplete/);
    assert.equal(builds, 1); assert.equal(quits, 1);
    fail = false;
    await closeDriver();
    await initDriver(OWNER);
    assert.equal(builds, 2); assert.equal(quits, 1);
});

test("another profile cannot share an initialized or initializing browser", async t => {
    const built = deferred();
    const browser = candidate();
    t.mock.method(Builder.prototype, "build", () => built.promise);
    const start = initDriver(OWNER);
    await assert.rejects(initDriver("223456789012345678"), /Another profile is leased/);
    built.resolve(browser); await start;
    await assert.rejects(initDriver("223456789012345678"), /Another profile is leased/);
});

test("failed candidate quit drains owned processes before releasing its persistent profile", async t => {
    const failure = new Error("navigation failed");
    const old = candidate({ get: async () => { throw failure; }, quit: async () => { throw new Error("quit failed"); } });
    let closes = 0;
    t.mock.method(BrowserProcess, "launch", async () => ({ url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: async () => { closes++; } }));
    t.mock.method(Builder.prototype, "build", async () => old);
    await assert.rejects(initDriver(OWNER), e => e === failure);
    assert.equal(closes, 1); assert.equal(old.quits, 1);
    assert.equal(getDriver(), null);
});

test('late search-selector failure cannot type into a replacement profile', async t => {
    const { BrowserControls } = await import('../dist/browser/controls.js');
    const selected = deferred(), old = candidate(), replacement = candidate();
    old.getCurrentUrl = async () => 'https://youtube.com/tv';
    old.findElement = () => selected.promise;
    replacement.getCurrentUrl = async () => 'https://app.plex.tv/desktop';
    let replacementTyping = 0;
    replacement.switchTo = () => ({ activeElement: async () => ({ sendKeys: async () => { replacementTyping++; } }) });
    let builds = 0; t.mock.method(Builder.prototype, 'build', async () => ++builds === 1 ? old : replacement);
    const controls = new BrowserControls(); await controls.initialize(OWNER);
    const searched = controls.search('private search text'), stale = assert.rejects(searched, /WebDriver not initialized/);
    await controls.close(); await controls.initialize(OWNER);
    selected.reject(new Error('old selector failed')); await stale;
    assert.equal(replacementTyping, 0); assert.equal(controls.getCurrentPreset().id, 'plex');
});

test('late navigation cannot overwrite preset metadata from a replacement profile', async t => {
    const { BrowserControls } = await import('../dist/browser/controls.js');
    const navigation = deferred(), old = candidate(), replacement = candidate();
    old.getCurrentUrl = async () => 'https://youtube.com/tv'; replacement.getCurrentUrl = async () => 'https://app.plex.tv/desktop';
    let builds = 0; t.mock.method(Builder.prototype, 'build', async () => ++builds === 1 ? old : replacement);
    const controls = new BrowserControls(); await controls.initialize(OWNER);
    old.get = () => navigation.promise;
    const navigated = controls.navigateTo('https://youtube.com/tv'), stale = assert.rejects(navigated, /WebDriver not initialized/);
    await controls.close(); await controls.initialize(OWNER); navigation.resolve(); await stale;
    assert.equal(controls.getCurrentPreset().id, 'plex');
});

test('closing an indefinitely stalled initial navigation settles without waiting for navigation', { timeout: 1000 }, async t => {
    const browser = candidate({ get: () => new Promise(() => {}) });
    t.mock.method(Builder.prototype, 'build', async () => browser);
    const startup = initDriver(OWNER), cancelled = assert.rejects(startup, /initialization cancelled/);
    await flush(); await closeDriver(); await cancelled;
    assert.equal(getDriver(), null); assert.equal(browser.quits, 1);
});
