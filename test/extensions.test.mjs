import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Builder } from "selenium-webdriver";
import { resolveBrowserExtensions, validateExtensionBrowser, stageBrowserExtensions } from "../dist/browser/extensions.js";
import { getChromeOptions, initDriver, closeDriver } from "../dist/browser/driver.js";
import { BrowserProcess } from "../dist/browser/processes.js";
import config from "../dist/config.js";
import logger from "../dist/utils/logger.js";

logger.silent = true;
const OWNER = "123456789012345678";
function driverFixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "theatrebot-extension-profile-")));
    const previous = { root: config.browser.profileRoot, paths: config.browser.extensionPaths, binary: process.env.CHROME_BIN };
    config.browser.profileRoot = root;
    const binary = join(root, "chromium-version");
    writeFileSync(binary, "#!/bin/sh\nprintf 'Chromium 154.0.8037.92\\n'\n", { mode: 0o700 });
    process.env.CHROME_BIN = binary;
    const launch = t.mock.method(BrowserProcess, "launch", async () => ({
        url: "http://127.0.0.1:4444", snapshot: async () => {}, verifyChrome: async () => {}, close: async () => {},
    }));
    t.after(async () => {
        await closeDriver();
        config.browser.profileRoot = previous.root;
        config.browser.extensionPaths = previous.paths;
        if (previous.binary === undefined) delete process.env.CHROME_BIN;
        else process.env.CHROME_BIN = previous.binary;
        rmSync(root, { recursive: true, force: true });
    });
    return { root, launch };
}
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "theatrebot-extensions-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return (name, manifest = { manifest_version: 3, name, version: "1.0" }) => {
        const path = join(root, name);
        mkdirSync(path);
        writeFileSync(join(path, "manifest.json"), JSON.stringify(manifest));
        return path;
    };
}

test("extensions are opt-in, with no asset reads or browser execution when disabled", () => {
    assert.deepEqual(resolveBrowserExtensions(""), []);
    assert.deepEqual(resolveBrowserExtensions(" [] "), []);
    validateExtensionBrowser([], "/nonexistent/browser");
    const options = getChromeOptions("/profile").get("goog:chromeOptions");
    assert.ok(options.args.includes("--disable-extensions"));
    assert.ok(!options.args.some(arg => arg.startsWith("--load-extension=")));
});

test("rejects malformed config and paths that can alter the Chromium list", t => {
    for (const raw of ["bad", "null", "{}", '"/tmp"', '[null]', '[1]', '["relative"]', '["--other"]', '["/tmp/a,b"]', '["/tmp/a\\n"]']) {
        assert.throws(() => resolveBrowserExtensions(raw), /BROWSER_EXTENSION_PATHS/);
    }
    assert.throws(() => resolveBrowserExtensions('["/nonexistent/extension"]'), /existing directory/);
    const extension = fixture(t)("broken");
    writeFileSync(join(extension, "manifest.json"), "bad");
    assert.throws(() => resolveBrowserExtensions(JSON.stringify([extension])), /valid manifest/);
});

test("validates actual MV3 manifests rather than assuming all unpacked assets work", t => {
    const create = fixture(t);
    for (const [i, manifest] of [null, [], {}, {manifest_version:2,name:"old",version:"1"},
        {manifest_version:3,name:"",version:"1"}, {manifest_version:3,name:"x",version:"bad"},
        {manifest_version:3,name:"x",version:"01"}, {manifest_version:3,name:"x",version:"65536"},
        {manifest_version:3,name:"x",version:"0.0"}].entries()) {
        const path = create(`invalid-${i}`, manifest);
        assert.throws(() => resolveBrowserExtensions(JSON.stringify([path])), /manifest|Manifest V3/);
    }
});

test("canonicalizes operator paths and rejects duplicate aliases", t => {
    const path = fixture(t)("valid");
    const alias = `${path}-alias`;
    symlinkSync(path, alias);
    assert.deepEqual(resolveBrowserExtensions(JSON.stringify([`${path}/../valid`])), [realpathSync(path)]);
    assert.throws(() => resolveBrowserExtensions(JSON.stringify([path, alias])), /duplicates/);
});

test("multiple enabled assets load together without a disabling ChromeDriver switch", t => {
    const create = fixture(t), paths = [create("SponsorBlock"), create("uBOL")];
    const canonical = paths.map(path => realpathSync(path));
    const options = getChromeOptions("/profile", canonical).get("goog:chromeOptions");
    assert.ok(options.args.includes(`--load-extension=${canonical.join(",")}`));
    assert.ok(options.args.includes(`--disable-extensions-except=${canonical.join(",")}`));
    assert.ok(!options.args.includes("--disable-extensions"));
    assert.ok(options.excludeSwitches.includes("disable-extensions"));
});

test("invalid assets fail before building a browser", async t => {
    const { root, launch } = driverFixture(t);
    config.browser.extensionPaths = "broken";
    const build = t.mock.method(Builder.prototype, "build", () => { throw new Error("must not build"); });
    await assert.rejects(initDriver(OWNER), /BROWSER_EXTENSION_PATHS/);
    assert.equal(build.mock.callCount(), 0);
    assert.equal(launch.mock.callCount(), 0);
    assert.equal(existsSync(join(root, ".theatrebot-browser-lease")), false);
    assert.equal(existsSync(join(root, OWNER, ".theatrebot-lease")), false);
});

test("driver loads writable copies only after acquiring the profile lease", async t => {
    const { root } = driverFixture(t);
    const paths = [fixture(t)("SponsorBlock"), fixture(t)("uBOL")];
    config.browser.extensionPaths = JSON.stringify(paths);
    let options;
    t.mock.method(Builder.prototype, "setChromeOptions", function(value) { options = value.get("goog:chromeOptions"); return this; });
    const browser = { get: async () => {}, quit: async () => {}, getCapabilities: async () => new Map([["goog:processID", 1]]) };
    t.mock.method(Builder.prototype, "build", async () => {
        assert.equal(existsSync(join(root, ".theatrebot-browser-lease")), true);
        assert.equal(existsSync(join(root, OWNER, ".theatrebot-lease")), true);
        return browser;
    });
    await initDriver(OWNER);
    const loaded = options.args.find(arg => arg.startsWith("--load-extension=")).slice("--load-extension=".length).split(",");
    assert.equal(loaded.length, 2);
    for (const path of loaded) {
        assert.ok(path.startsWith(join(root, OWNER, ".theatrebot-extensions") + "/"));
        assert.equal(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).manifest_version, 3);
    }
    assert.ok(!options.args.includes("--disable-extensions"));
    assert.ok(options.args.includes(`--user-data-dir=${join(root, OWNER)}`));
    await closeDriver();
    assert.equal(existsSync(join(root, ".theatrebot-browser-lease")), false);
});

test("a staging failure releases the lease without starting ChromeDriver", async t => {
    const { root, launch } = driverFixture(t);
    const source = fixture(t)("source");
    symlinkSync(join(source, "manifest.json"), join(source, "escape"));
    config.browser.extensionPaths = JSON.stringify([source]);
    const build = t.mock.method(Builder.prototype, "build", () => { throw new Error("must not build"); });
    await assert.rejects(initDriver(OWNER), /symlinks/);
    assert.equal(launch.mock.callCount(), 0);
    assert.equal(build.mock.callCount(), 0);
    assert.equal(existsSync(join(root, ".theatrebot-browser-lease")), false);
    assert.equal(existsSync(join(root, OWNER, ".theatrebot-lease")), false);
});

test("browser compatibility failures explain how to select a supported binary", t => {
    assert.throws(() => validateExtensionBrowser(["/asset"], "/nonexistent/browser"), /CHROME_BIN/);
    const create = fixture(t), directory = create("browser");
    const binary = join(directory, "version");
    for (const brand of ["Chromium 154.0.8037.92", "Google Chrome for Testing 154.0.0.0", "Google Chrome 154.0.0.0"]) {
        writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${brand}'\n`, { mode: 0o700 });
        if (brand.includes("Chromium") || brand.includes("Testing")) validateExtensionBrowser(["/asset"], binary);
        else assert.throws(() => validateExtensionBrowser(["/asset"], binary), /branded Google Chrome/);
    }
});

test("stages immutable sources into isolated private profile caches and preserves identity on updates", async t => {
    const create = fixture(t), source = create("source"), one = create("profile-one"), two = create("profile-two");
    writeFileSync(join(source, "asset.js"), "version one");
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    manifest.key = "upstream-key-preserved-verbatim";
    writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
    const raw = JSON.stringify([source]);
    const [first] = await stageBrowserExtensions(raw, one);
    const [other] = await stageBrowserExtensions(raw, two);
    assert.notEqual(first, other);
    assert.equal(readFileSync(join(first, "asset.js"), "utf8"), "version one");
    assert.deepEqual(JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")), manifest);
    writeFileSync(join(first, "chromium-index"), "generated");
    assert.equal(existsSync(join(source, "chromium-index")), false);
    writeFileSync(join(source, "asset.js"), "version two");
    const [updated] = await stageBrowserExtensions(raw, one);
    assert.equal(updated, first);
    assert.equal(readFileSync(join(updated, "asset.js"), "utf8"), "version two");
    assert.equal(readFileSync(join(other, "asset.js"), "utf8"), "version one");
    assert.equal(existsSync(join(updated, "chromium-index")), false);
});

test("staging rejects source symlinks and unowned or nonprivate cache directories", async t => {
    const create = fixture(t), source = create("source"), profile = create("profile"), other = create("other");
    symlinkSync(join(other, "manifest.json"), join(source, "escape"));
    await assert.rejects(stageBrowserExtensions(JSON.stringify([source]), profile), /symlinks/);
    rmSync(join(source, "escape"));
    rmSync(join(profile, ".theatrebot-extensions"), { recursive: true });
    symlinkSync(other, join(profile, ".theatrebot-extensions"));
    await assert.rejects(stageBrowserExtensions(JSON.stringify([source]), profile), /private directory/);
    rmSync(join(profile, ".theatrebot-extensions"));
    mkdirSync(join(profile, ".theatrebot-extensions"), {mode:0o700});
    chmodSync(join(profile, ".theatrebot-extensions"), 0o755);
    await assert.rejects(stageBrowserExtensions(JSON.stringify([source]), profile), /private directory/);
    assert.deepEqual(await stageBrowserExtensions("", "/does-not-exist"), []);
});
