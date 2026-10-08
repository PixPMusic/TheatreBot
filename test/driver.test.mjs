import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Builder, WebDriver, Session, error } from "selenium-webdriver";
import { Name } from "selenium-webdriver/lib/command.js";
import { initDriver, getDriver, closeDriver } from "../dist/browser/driver.js";
import config from "../dist/config.js";
import logger from "../dist/utils/logger.js";

logger.silent = true;
afterEach(closeDriver);

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function candidate({ get = async () => {}, quit = async () => {} } = {}) {
    const browser = { urls: [], quits: 0 };
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

const flush = () => new Promise(resolve => setImmediate(resolve));

test("concurrent startup shares build and navigation and publishes only a ready driver", async t => {
    const built = deferred(), navigated = deferred();
    const browser = candidate({ get: () => navigated.promise });
    const build = t.mock.method(Builder.prototype, "build", () => built.promise);
    const first = initDriver(), second = initDriver();
    assert.equal(first, second);
    assert.equal(getDriver(), null);
    await flush();
    assert.equal(build.mock.callCount(), 1);
    built.resolve(browser);
    await flush();
    assert.deepEqual(browser.urls, [config.browser.defaultUrl]);
    assert.equal(getDriver(), null);
    assert.equal(initDriver(), first);
    navigated.resolve();
    assert.equal(await first, browser);
    assert.equal(await second, browser);
    assert.equal(getDriver(), browser);
    assert.equal(await initDriver(), browser);
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
        const first = initDriver(), second = initDriver();
        await assert.rejects(first, error => error === failure);
        await assert.rejects(second, error => error === failure);
        assert.equal(getDriver(), null);
        assert.equal(await initDriver(), browser);
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
    const startup = initDriver();
    const rejected = assert.rejects(startup, error => error === failure);
    await flush();
    assert.equal(getDriver(), null);
    assert.equal(failed.quits, 1);
    assert.equal(initDriver(), startup);
    assert.equal(build.mock.callCount(), 1);
    disposal.resolve();
    await rejected;
    assert.equal(await initDriver(), replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(failed.quits, 1);
});

test("close during build cancels late publication and delays replacement until disposal", async t => {
    const built = deferred(), disposal = deferred();
    const old = candidate({ quit: () => disposal.promise });
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        ++builds === 1 ? built.promise : Promise.resolve(replacement));
    const startup = initDriver();
    const cancelled = assert.rejects(startup, /initialization cancelled/);
    await flush();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    const restart = initDriver(), otherRestart = initDriver();
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
        const startup = initDriver();
        const rejected = assert.rejects(startup, fails ? /navigation failed/ : /initialization cancelled/);
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
    await initDriver();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    assert.equal(getDriver(), null);
    const restart = initDriver();
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
    const startup = initDriver();
    const rejected = assert.rejects(startup, /initialization cancelled/);
    await closeDriver();
    await rejected;
    assert.equal(getDriver(), null);
    assert.equal(build.mock.callCount(), 0);
});

test("failed ready disposal releases the spent Selenium handle and allows fresh startup", async t => {
    const disposal = deferred();
    const failure = new Error("quit failed");
    const old = seleniumCandidate(t, { quit: () => disposal.promise });
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        Promise.resolve(++builds === 1 ? old.driver : replacement));
    await initDriver();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    assert.equal(getDriver(), null);
    const closed = assert.rejects(close, error => error === failure);
    const queued = assert.rejects(initDriver(), error => error === failure);
    await flush();
    assert.deepEqual(old.commands, [Name.GET, Name.QUIT]);
    assert.equal(old.onQuit.mock.callCount(), 0);
    assert.equal(build.mock.callCount(), 1);
    disposal.reject(failure);
    await closed;
    await queued;
    assert.equal(getDriver(), null);
    assert.equal(build.mock.callCount(), 1);
    await assert.rejects(old.driver.getSession(), error.NoSuchSessionError);
    await closeDriver();
    const restart = initDriver(), otherRestart = initDriver();
    assert.equal(await restart, replacement);
    assert.equal(await otherRestart, replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(old.quitCall.mock.callCount(), 1);
    assert.equal(old.onQuit.mock.callCount(), 1);
    assert.deepEqual(old.commands, [Name.GET, Name.QUIT]);
});

test("failed Selenium onQuit finalization releases the handle after successful QUIT", async t => {
    const finalized = deferred();
    const failure = new Error("service teardown failed");
    const old = seleniumCandidate(t, { onQuit: () => finalized.promise });
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        Promise.resolve(++builds === 1 ? old.driver : replacement));
    await initDriver();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    const closed = assert.rejects(close, error => error === failure);
    const queued = assert.rejects(initDriver(), error => error === failure);
    await flush();
    assert.equal(getDriver(), null);
    assert.deepEqual(old.commands, [Name.GET, Name.QUIT]);
    assert.equal(old.onQuit.mock.callCount(), 1);
    assert.equal(build.mock.callCount(), 1);
    await assert.rejects(old.driver.getSession(), error.NoSuchSessionError);
    finalized.reject(failure);
    await closed;
    await queued;
    await closeDriver();
    assert.equal(await initDriver(), replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(old.quitCall.mock.callCount(), 1);
    assert.equal(old.onQuit.mock.callCount(), 1);
    assert.deepEqual(old.commands, [Name.GET, Name.QUIT]);
});

test("failed candidate disposal preserves the startup error and releases its spent Selenium handle", async t => {
    const failure = new Error("navigation failed");
    const cleanupFailure = new Error("quit failed");
    const disposal = deferred();
    const failed = seleniumCandidate(t, {
        get: async () => { throw failure; },
        quit: () => disposal.promise,
    });
    const logged = t.mock.method(logger, "error");
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        Promise.resolve(++builds === 1 ? failed.driver : replacement));
    const startup = initDriver();
    const rejected = assert.rejects(startup, error => error === failure);
    await flush();
    assert.equal(getDriver(), null);
    assert.equal(initDriver(), startup);
    assert.deepEqual(failed.commands, [Name.GET, Name.QUIT]);
    assert.equal(failed.onQuit.mock.callCount(), 0);
    assert.equal(build.mock.callCount(), 1);
    disposal.reject(cleanupFailure);
    await rejected;
    assert.equal(getDriver(), null);
    assert.ok(logged.mock.calls.some(call => call.arguments.includes(cleanupFailure)));
    await assert.rejects(failed.driver.getSession(), error.NoSuchSessionError);
    await closeDriver();
    const restart = initDriver(), otherRestart = initDriver();
    assert.equal(await restart, replacement);
    assert.equal(await otherRestart, replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(failed.quitCall.mock.callCount(), 1);
    assert.equal(failed.onQuit.mock.callCount(), 1);
    assert.deepEqual(failed.commands, [Name.GET, Name.QUIT]);
});

test("close waits for cancelled startup cleanup without retrying a spent Selenium handle", async t => {
    const built = deferred(), disposal = deferred();
    const cleanupFailure = new Error("candidate cleanup failed");
    const old = seleniumCandidate(t, { quit: () => disposal.promise });
    const replacement = candidate();
    let builds = 0;
    const build = t.mock.method(Builder.prototype, "build", () =>
        ++builds === 1 ? built.promise : Promise.resolve(replacement));
    const startup = initDriver();
    const cancelled = assert.rejects(startup, /initialization cancelled/);
    await flush();
    const close = closeDriver();
    assert.equal(closeDriver(), close);
    const restart = initDriver(), otherRestart = initDriver();
    built.resolve(old.driver);
    await flush();
    assert.equal(getDriver(), null);
    assert.deepEqual(old.commands, [Name.QUIT]);
    assert.equal(old.onQuit.mock.callCount(), 0);
    assert.equal(build.mock.callCount(), 1);
    assert.equal(closeDriver(), close);
    disposal.reject(cleanupFailure);
    await cancelled;
    await close;
    await assert.rejects(old.driver.getSession(), error.NoSuchSessionError);
    assert.equal(await restart, replacement);
    assert.equal(await otherRestart, replacement);
    assert.equal(build.mock.callCount(), 2);
    assert.equal(old.quitCall.mock.callCount(), 1);
    assert.equal(old.onQuit.mock.callCount(), 1);
    assert.deepEqual(old.commands, [Name.QUIT]);
});
