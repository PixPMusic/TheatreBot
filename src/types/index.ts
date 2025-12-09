// ===========================================
// Stream Status Types
// ===========================================

export interface ChannelInfo {
    guildId: string;
    channelId: string;
}

export interface StreamStatus {
    joined: boolean;
    playing: boolean;
    manualStop: boolean;
    channelInfo: ChannelInfo | null;
}

// ===========================================
// Session Types
// ===========================================

export interface Session {
    id: string;
    guildId: string;
    channelId: string;
    startedBy: string; // Discord user ID who started this session
    createdAt: Date;
    currentUrl: string;
}

// ===========================================
// RBAC Types
// ===========================================

export type PermissionLevel = "join" | "control" | "navigate" | "admin";

export interface ServerPermissions {
    guildId: string;
    join: string[];      // Array of role/user IDs
    control: string[];
    navigate: string[];
    admin: string[];
}

// ===========================================
// Browser Control Types
// ===========================================

export type NavigationKey = 
    | "ArrowUp" 
    | "ArrowDown" 
    | "ArrowLeft" 
    | "ArrowRight" 
    | "Enter" 
    | "Escape" 
    | "Backspace"
    | "Tab"
    | "Space";

export interface BrowserAction {
    type: "navigate" | "key" | "click" | "scroll" | "type";
    payload: {
        url?: string;
        key?: NavigationKey | string;
        x?: number;
        y?: number;
        direction?: "up" | "down";
        text?: string;
    };
}

// ===========================================
// Preset Types
// ===========================================

export interface Preset {
    id: string;
    name: string;
    url: string;
    icon?: string;
    // Selector for the search input field on this site
    searchSelector?: string;
}

import config from "../config.js";

export const DEFAULT_PRESETS: Preset[] = [
    {
        id: "youtube-tv",
        name: "YouTube TV",
        url: config.presets.youtube,
        icon: "📺",
        searchSelector: "input#search",
    },
    {
        id: "plex",
        name: "Plex",
        url: config.presets.plex,
        icon: "🎬",
        searchSelector: "input[data-testid='search-input']",
    },
];
