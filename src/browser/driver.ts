import { Builder, Browser, type WebDriver, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { acquireProfile, type ProfileLease } from "./profiles.js";
import { BrowserProcess } from "./processes.js";
import config from "../config.js";
import logger from "../utils/logger.js";
import type { NavigationKey, BrowserAction } from "../types/index.js";

import { validateNavigationUrl } from "./url.js";
import { resolveBrowserExtensions, validateExtensionBrowser, stageBrowserExtensions } from "./extensions.js";

let driver: WebDriver | null = null;
let owner: string | null = null;
let lease: ProfileLease | null = null;
let browserProcess: BrowserProcess | null = null;
let cleanupBlocked = false;
// Own a browser while quit is pending, without exposing an unusable session.
let retiringDriver: WebDriver | null = null;
let initialization: { cancelled: boolean; controller: AbortController } | null = null;
let initializing: Promise<WebDriver> | null = null;
let closing: Promise<void> | null = null;

/**
 * Map our NavigationKey type to Selenium Key values.
 */
const KEY_MAP: Record<NavigationKey, string> = {
    ArrowUp: Key.ARROW_UP,
    ArrowDown: Key.ARROW_DOWN,
    ArrowLeft: Key.ARROW_LEFT,
    ArrowRight: Key.ARROW_RIGHT,
    Enter: Key.ENTER,
    Escape: Key.ESCAPE,
    Backspace: Key.BACK_SPACE,
    Tab: Key.TAB,
    Space: Key.SPACE,
};

/**
 * Get Chrome options for the browser.
 */
export function getChromeOptions(profileDirectory: string, extensionPaths: readonly string[] = []): chrome.Options {
    const options = new chrome.Options();
    options.addArguments(`--user-data-dir=${profileDirectory}`);

    // Set Chromium binary path (for container with Chromium from Fedora repos)
    const chromeBin = process.env.CHROME_BIN || "/usr/lib64/chromium-browser/chromium-browser";
    options.setChromeBinaryPath(chromeBin);

    // Essential flags for streaming
    options.addArguments(
        // User agent for TV compatibility (YouTube TV, etc.)
        `--user-agent=${config.browser.userAgent}`,
        
        // Audio settings
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
        
        // Performance and stability
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        
        // Window size matching stream resolution
        `--window-size=${config.stream.width},${config.stream.height}`,
        
        // Kiosk mode for TV-like experience
        "--kiosk",
        "--start-fullscreen",
        
        // Suppress infobars
        "--disable-infobars",
        "--disable-translate",
        "--disable-popup-blocking",
        
        // Enable audio
        "--use-fake-ui-for-media-stream",
        
        // Performance optimizations
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    );

    // Hide "Chrome is being controlled by automated test software"
    if (extensionPaths.length) {
        options.addArguments(
            `--load-extension=${extensionPaths.join(",")}`,
            `--disable-extensions-except=${extensionPaths.join(",")}`,
        );
        // ChromeDriver can otherwise add a disabling switch of its own.
        options.excludeSwitches("enable-automation", "disable-extensions");
    } else {
        options.addArguments("--disable-extensions");
        options.excludeSwitches("enable-automation");
    }
    options.setUserPreferences({
        "useAutomationExtension": false,
        "credentials_enable_service": false,
        "profile.password_manager_enabled": false
    });

    return options;
}

/**
 * Initialize the Selenium WebDriver with Chrome.
 */
export function initDriver(userId: string): Promise<WebDriver> {
    if (!/^\d{1,20}$/.test(userId)) return Promise.reject(new Error("A Discord profile owner is required"));
    if (cleanupBlocked) return Promise.reject(new Error("Browser cleanup is incomplete; retry !leave"));
    if (owner && owner !== userId) return Promise.reject(new Error("Another profile is leased"));
    // Wait for disposal before allowing a replacement browser to start.
    if (closing) {
        return closing.then(() => initDriver(userId));
    }
    if (driver) {
        return Promise.resolve(driver);
    }
    if (initializing) {
        return initializing;
    }

    owner = userId;
    const attempt = { cancelled: false, controller: new AbortController() };
    initialization = attempt;
    // Defer work so the shared promise is installed before any build can start.
    initializing = Promise.resolve().then(async () => {
        let candidate: WebDriver | null = null;
        try {
            if (attempt.cancelled) {
                throw new Error("WebDriver initialization cancelled by closeDriver");
            }

            logger.info(`Initializing Chrome WebDriver on display ${config.browser.display}`);
            logger.info(`Default URL: ${config.browser.defaultUrl}`);
            logger.info(`User Agent: ${config.browser.userAgent}`);

            const defaultUrl = validateNavigationUrl(config.browser.defaultUrl);
            lease = await acquireProfile(config.browser.profileRoot, userId);
            if (attempt.cancelled) throw new Error("WebDriver initialization cancelled by closeDriver");
            validateExtensionBrowser(resolveBrowserExtensions(config.browser.extensionPaths),
                process.env.CHROME_BIN || "/usr/lib64/chromium-browser/chromium-browser");
            const extensionPaths = await stageBrowserExtensions(config.browser.extensionPaths, lease.directory);
            if (attempt.cancelled) throw new Error("WebDriver initialization cancelled by closeDriver");
            const options = getChromeOptions(lease.directory, extensionPaths);
            browserProcess = await BrowserProcess.launch(process => { browserProcess = process; });
            const build = new Builder()
                .forBrowser(Browser.CHROME)
                .setChromeOptions(options)
                .usingServer(browserProcess.url)
                .build().then(built => {
                    if (attempt.cancelled) void built.quit().catch(error => logger.error("Late cancelled Selenium session cleanup failed:", error));
                    return built;
                });
            let buildTimer: ReturnType<typeof setTimeout> | undefined;
            try { candidate = await Promise.race([build, new Promise<never>((_, reject) => {
                buildTimer = setTimeout(() => reject(new Error("Chrome startup timed out")), 20_000);
            }), new Promise<never>((_, reject) => {
                if (attempt.cancelled) reject(new Error("WebDriver initialization cancelled by closeDriver"));
                else attempt.controller.signal.addEventListener('abort', () => reject(new Error("WebDriver initialization cancelled by closeDriver")), { once: true });
            })]); } finally { if (buildTimer) clearTimeout(buildTimer); }

            if (attempt.cancelled) {
                throw new Error("WebDriver initialization cancelled by closeDriver");
            }
            await browserProcess.verifyChrome((await candidate.getCapabilities()).get("goog:processID"), lease.directory);
            logger.info("Chrome WebDriver built successfully");

            let navigationTimer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([candidate.get(defaultUrl), new Promise<never>((_, reject) => {
                navigationTimer = setTimeout(() => reject(new Error("Initial browser navigation timed out")), 20_000);
            }), new Promise<never>((_, reject) => {
                if (attempt.cancelled) reject(new Error("WebDriver initialization cancelled by closeDriver"));
                else attempt.controller.signal.addEventListener('abort', () => reject(new Error("WebDriver initialization cancelled by closeDriver")), { once: true });
            })]); } finally { if (navigationTimer) clearTimeout(navigationTimer); }
            if (attempt.cancelled) {
                throw new Error("WebDriver initialization cancelled by closeDriver");
            }
            logger.info(`Chrome navigated to ${config.browser.defaultUrl}`);
            driver = candidate;
            return candidate;
        } catch (error) {
            retiringDriver = candidate;
            try { await dispose(); } catch (cleanupError) {
                cleanupBlocked = true;
                logger.error("Browser cleanup blocked:", cleanupError);
            }
            logger.error("Failed to initialize Chrome WebDriver:", error);
            throw error;
        }
    }).finally(() => {
        initialization = null;
        initializing = null;
    });

    return initializing;
}

/**
 * Get the current WebDriver instance.
 */
export function getDriver(): WebDriver | null {
    return driver;
}

/**
 * Navigate to a URL.
 */
export async function navigate(url: string, expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    const validated = validateNavigationUrl(url);
    logger.info(`Navigating to ${validated}`);
    await expected.get(validated);
}

/**
 * Get the current URL.
 */
export async function getCurrentUrl(expected: WebDriver | null = driver): Promise<string> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    return await expected.getCurrentUrl();
}

/**
 * Send a navigation key (arrow, enter, escape, etc).
 */
export async function sendKey(key: NavigationKey, expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    const seleniumKey = KEY_MAP[key];
    if (!seleniumKey) {
        throw new Error(`Unknown key: ${key}`);
    }

    logger.debug(`Sending key: ${key}`);
    
    // Send key to the active element (or body if none)
    const activeElement = await expected.switchTo().activeElement();
    assertDriver(expected);
    await activeElement.sendKeys(seleniumKey);
}

/**
 * Type text into the currently focused element.
 */
export async function typeText(text: string, expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug("Typing into owner browser");
    
    const activeElement = await expected.switchTo().activeElement();
    assertDriver(expected);
    await activeElement.sendKeys(text);
}

/**
 * Click at specific coordinates.
 */
export async function clickAt(x: number, y: number, expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug(`Clicking at (${x}, ${y})`);
    
    const actions = expected.actions({ async: true });
    // Move relative to viewport and click
    await actions.move({ x, y }).click().perform();
}

/**
 * Scroll the page.
 */
export async function scroll(direction: "up" | "down", expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    const key = direction === "up" ? Key.PAGE_UP : Key.PAGE_DOWN;
    
    logger.debug(`Scrolling ${direction}`);
    
    const body = await expected.findElement({ css: "body" });
    assertDriver(expected);
    await body.sendKeys(key);
}

/**
 * Execute a browser action.
 */
export async function executeAction(action: BrowserAction, expected: WebDriver | null = driver): Promise<void> {
    switch (action.type) {
        case "navigate":
            if (action.payload.url) {
                await navigate(action.payload.url, expected);
            }
            break;
        case "key":
            if (action.payload.key) {
                await sendKey(action.payload.key as NavigationKey, expected);
            }
            break;
        case "click":
            if (action.payload.x !== undefined && action.payload.y !== undefined) {
                await clickAt(action.payload.x, action.payload.y, expected);
            }
            break;
        case "scroll":
            if (action.payload.direction) {
                await scroll(action.payload.direction, expected);
            }
            break;
        case "type":
            if (action.payload.text) {
                await typeText(action.payload.text, expected);
            }
            break;
    }
}

/**
 * Focus and type into a specific element (for preset search boxes).
 */
export async function focusAndType(selector: string, text: string, expected: WebDriver | null = driver): Promise<void> {
    if (!expected || expected !== driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug(`Focusing on ${selector} and typing`);
    
    const element = await expected.findElement({ css: selector });
    assertDriver(expected);
    await element.click();
    assertDriver(expected);
    await element.clear();
    assertDriver(expected);
    await element.sendKeys(text);
}

/**
 * Close the browser.
 */
export function assertDriver(expected: WebDriver | null): asserts expected is WebDriver {
    if (!expected || expected !== driver) throw new Error("Browser session changed");
}

async function dispose(): Promise<void> {
    const retiring = retiringDriver;
    retiringDriver = null; // Never reuse an invalidated Selenium session, including failed quit.
    if (browserProcess) await browserProcess.snapshot();
    if (retiring) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([retiring.quit(), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Chrome quit timed out")), 10_000);
        })]); } catch (error) { logger.error("Selenium quit failed; disposing owned processes:", error); }
        finally { if (timeout) clearTimeout(timeout); }
    }
    await browserProcess?.close();
    browserProcess = null;
    await lease?.release();
    lease = null;
    owner = null;
    cleanupBlocked = false;
}

export function closeDriver(): Promise<void> {
    if (closing) return closing;
    if (initialization) { initialization.cancelled = true; initialization.controller.abort(); }
    const pending = initializing;
    if (driver) retiringDriver = driver;
    driver = null;
    closing = Promise.resolve().then(async () => {
        if (pending) await pending.catch(() => {});
        await dispose();
    }).catch(error => { cleanupBlocked = true; throw error; }).finally(() => { closing = null; });
    return closing;
}
