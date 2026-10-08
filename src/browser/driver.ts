import { Builder, Browser, type WebDriver, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import config from "../config.js";
import logger from "../utils/logger.js";
import type { NavigationKey, BrowserAction, Preset, DEFAULT_PRESETS } from "../types/index.js";

import { validateNavigationUrl } from "./url.js";

let driver: WebDriver | null = null;
// Keep ownership until quit succeeds, without exposing an unusable browser.
let retiringDriver: WebDriver | null = null;
let initialization: { cancelled: boolean } | null = null;
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
function getChromeOptions(): chrome.Options {
    const options = new chrome.Options();

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
        
        // Disable extensions and infobars
        "--disable-extensions",
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
    options.excludeSwitches("enable-automation");
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
export function initDriver(): Promise<WebDriver> {
    // Wait for disposal before allowing a replacement browser to start.
    if (closing) {
        return closing.then(() => initDriver());
    }
    if (driver) {
        return Promise.resolve(driver);
    }
    if (initializing) {
        return initializing;
    }
    if (retiringDriver) {
        return closeDriver().then(() => initDriver());
    }

    const attempt = { cancelled: false };
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
            const options = getChromeOptions();
            const chromedriverPath = process.env.CHROMEDRIVER_PATH || "/usr/lib64/chromium-browser/chromedriver";
            const service = new chrome.ServiceBuilder(chromedriverPath);
            candidate = await new Builder()
                .forBrowser(Browser.CHROME)
                .setChromeOptions(options)
                .setChromeService(service)
                .build();

            if (attempt.cancelled) {
                throw new Error("WebDriver initialization cancelled by closeDriver");
            }
            logger.info("Chrome WebDriver built successfully");

            await candidate.get(defaultUrl);
            if (attempt.cancelled) {
                throw new Error("WebDriver initialization cancelled by closeDriver");
            }
            logger.info(`Chrome navigated to ${config.browser.defaultUrl}`);
            driver = candidate;
            return candidate;
        } catch (error) {
            if (candidate) {
                retiringDriver = candidate;
                try {
                    await candidate.quit();
                    retiringDriver = null;
                } catch (cleanupError) {
                    logger.error("Failed to close uninitialized Chrome WebDriver:", cleanupError);
                }
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
export async function navigate(url: string): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    const validated = validateNavigationUrl(url);
    logger.info(`Navigating to ${validated}`);
    await driver.get(validated);
}

/**
 * Get the current URL.
 */
export async function getCurrentUrl(): Promise<string> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    return await driver.getCurrentUrl();
}

/**
 * Send a navigation key (arrow, enter, escape, etc).
 */
export async function sendKey(key: NavigationKey): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    const seleniumKey = KEY_MAP[key];
    if (!seleniumKey) {
        throw new Error(`Unknown key: ${key}`);
    }

    logger.debug(`Sending key: ${key}`);
    
    // Send key to the active element (or body if none)
    const activeElement = await driver.switchTo().activeElement();
    await activeElement.sendKeys(seleniumKey);
}

/**
 * Type text into the currently focused element.
 */
export async function typeText(text: string): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug(`Typing text: ${text.substring(0, 20)}...`);
    
    const activeElement = await driver.switchTo().activeElement();
    await activeElement.sendKeys(text);
}

/**
 * Click at specific coordinates.
 */
export async function clickAt(x: number, y: number): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug(`Clicking at (${x}, ${y})`);
    
    const actions = driver.actions({ async: true });
    // Move relative to viewport and click
    await actions.move({ x, y }).click().perform();
}

/**
 * Scroll the page.
 */
export async function scroll(direction: "up" | "down"): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    const key = direction === "up" ? Key.PAGE_UP : Key.PAGE_DOWN;
    
    logger.debug(`Scrolling ${direction}`);
    
    const body = await driver.findElement({ css: "body" });
    await body.sendKeys(key);
}

/**
 * Execute a browser action.
 */
export async function executeAction(action: BrowserAction): Promise<void> {
    switch (action.type) {
        case "navigate":
            if (action.payload.url) {
                await navigate(action.payload.url);
            }
            break;
        case "key":
            if (action.payload.key) {
                await sendKey(action.payload.key as NavigationKey);
            }
            break;
        case "click":
            if (action.payload.x !== undefined && action.payload.y !== undefined) {
                await clickAt(action.payload.x, action.payload.y);
            }
            break;
        case "scroll":
            if (action.payload.direction) {
                await scroll(action.payload.direction);
            }
            break;
        case "type":
            if (action.payload.text) {
                await typeText(action.payload.text);
            }
            break;
    }
}

/**
 * Focus and type into a specific element (for preset search boxes).
 */
export async function focusAndType(selector: string, text: string): Promise<void> {
    if (!driver) {
        throw new Error("WebDriver not initialized");
    }

    logger.debug(`Focusing on ${selector} and typing`);
    
    const element = await driver.findElement({ css: selector });
    await element.click();
    await element.clear();
    await element.sendKeys(text);
}

/**
 * Close the browser.
 */
export function closeDriver(): Promise<void> {
    if (closing) {
        return closing;
    }
    if (!driver && !initializing && !retiringDriver) {
        return Promise.resolve();
    }

    if (initialization) {
        initialization.cancelled = true;
    }
    const pending = initializing;
    if (driver) {
        retiringDriver = driver;
    }
    driver = null;
    closing = Promise.resolve().then(async () => {
        if (pending) {
            // Initialization attempts cleanup first; retry any retained candidate.
            await pending.catch(() => {});
        }
        if (retiringDriver) {
            await retiringDriver.quit();
            retiringDriver = null;
            logger.info("Chrome WebDriver closed");
        }
    }).finally(() => {
        closing = null;
    });
    return closing;
}
