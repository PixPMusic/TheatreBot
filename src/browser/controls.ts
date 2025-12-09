import * as driverModule from "./driver.js";
import type { NavigationKey, BrowserAction, Preset } from "../types/index.js";
import { DEFAULT_PRESETS } from "../types/index.js";
import logger from "../utils/logger.js";

/**
 * BrowserControls provides a high-level API for remote control of the browser.
 * Handles navigation, key input, and context-aware preset functionality.
 */
export class BrowserControls {
    private presets: Preset[] = [...DEFAULT_PRESETS];
    private currentPreset: Preset | null = null;

    /**
     * Initialize the browser with a starting URL.
     */
    public async initialize(startUrl?: string): Promise<void> {
        await driverModule.initDriver();
        
        if (startUrl) {
            await this.navigateTo(startUrl);
        }
        
        // Detect current preset from URL
        await this.detectCurrentPreset();
    }

    /**
     * Navigate to a URL.
     */
    public async navigateTo(url: string): Promise<void> {
        await driverModule.navigate(url);
        await this.detectCurrentPreset();
    }

    /**
     * Navigate to a preset by ID.
     */
    public async navigateToPreset(presetId: string): Promise<void> {
        const preset = this.presets.find(p => p.id === presetId);
        if (!preset) {
            throw new Error(`Unknown preset: ${presetId}`);
        }

        await driverModule.navigate(preset.url);
        this.currentPreset = preset;
        logger.info(`Navigated to preset: ${preset.name}`);
    }

    /**
     * Get the current URL.
     */
    public async getCurrentUrl(): Promise<string> {
        return await driverModule.getCurrentUrl();
    }

    /**
     * Get the currently detected preset (if any).
     */
    public getCurrentPreset(): Preset | null {
        return this.currentPreset;
    }

    /**
     * Get all available presets.
     */
    public getPresets(): Preset[] {
        return [...this.presets];
    }

    /**
     * Add a custom preset.
     */
    public addPreset(preset: Preset): void {
        this.presets.push(preset);
    }

    /**
     * Detect the current preset based on URL.
     */
    private async detectCurrentPreset(): Promise<void> {
        const currentUrl = await driverModule.getCurrentUrl();
        
        for (const preset of this.presets) {
            if (currentUrl.includes(new URL(preset.url).hostname)) {
                this.currentPreset = preset;
                logger.debug(`Detected preset: ${preset.name}`);
                return;
            }
        }
        
        this.currentPreset = null;
    }

    /**
     * Send a navigation key.
     */
    public async sendKey(key: NavigationKey): Promise<void> {
        await driverModule.sendKey(key);
    }

    /**
     * Type text into the currently focused element.
     */
    public async typeText(text: string): Promise<void> {
        await driverModule.typeText(text);
    }

    /**
     * Search using the current preset's search functionality.
     * This focuses the search input and types the query.
     */
    public async search(query: string): Promise<void> {
        if (!this.currentPreset?.searchSelector) {
            // No search selector, just type into the active element
            logger.warn("No search selector for current preset, typing directly");
            await driverModule.typeText(query);
            return;
        }

        try {
            await driverModule.focusAndType(this.currentPreset.searchSelector, query);
            logger.info(`Searched for: ${query}`);
        } catch (error) {
            logger.error(`Failed to use search selector, falling back to direct typing:`, error);
            await driverModule.typeText(query);
        }
    }

    /**
     * Submit search (press Enter after typing).
     */
    public async submitSearch(query: string): Promise<void> {
        await this.search(query);
        await driverModule.sendKey("Enter");
    }

    /**
     * Click at coordinates.
     */
    public async click(x: number, y: number): Promise<void> {
        await driverModule.clickAt(x, y);
    }

    /**
     * Scroll the page.
     */
    public async scroll(direction: "up" | "down"): Promise<void> {
        await driverModule.scroll(direction);
    }

    /**
     * Execute a browser action.
     */
    public async executeAction(action: BrowserAction): Promise<void> {
        await driverModule.executeAction(action);
        
        // Re-detect preset if navigation occurred
        if (action.type === "navigate") {
            await this.detectCurrentPreset();
        }
    }

    /**
     * Go back in browser history.
     */
    public async goBack(): Promise<void> {
        const driver = driverModule.getDriver();
        if (driver) {
            await driver.navigate().back();
            await this.detectCurrentPreset();
        }
    }

    /**
     * Refresh the page.
     */
    public async refresh(): Promise<void> {
        const driver = driverModule.getDriver();
        if (driver) {
            await driver.navigate().refresh();
        }
    }

    /**
     * Close the browser.
     */
    public async close(): Promise<void> {
        await driverModule.closeDriver();
        this.currentPreset = null;
    }
}

// Singleton instance
let browserControls: BrowserControls | null = null;

export function getBrowserControls(): BrowserControls {
    if (!browserControls) {
        browserControls = new BrowserControls();
    }
    return browserControls;
}
