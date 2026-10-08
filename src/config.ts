import dotenv from "dotenv";

dotenv.config();

// ===========================================
// Parsing Utilities
// ===========================================

function parseBoolean(value: string | undefined): boolean {
    if (typeof value === "string") {
        return value.trim().toLowerCase() === "true";
    }
    return false;
}

function parseInt(value: string | undefined, defaultValue: number): number {
    if (value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return defaultValue;
}

function parseString(value: string | undefined, defaultValue: string): string {
    if (value) {
        // Strip surrounding quotes (single or double) that may come from env files
        return value.replace(/^['"]|['"]$/g, "");
    }
    return defaultValue;
}

type VideoCodec = "VP8" | "H264" | "H265";
const VALID_VIDEO_CODECS: VideoCodec[] = ["VP8", "H264", "H265"];

function parseVideoCodec(value: string | undefined): VideoCodec {
    if (value) {
        const normalized = value.trim().toUpperCase() as VideoCodec;
        if (VALID_VIDEO_CODECS.includes(normalized)) {
            return normalized;
        }
    }
    return "H264";
}

type H26xPreset = "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
const VALID_PRESETS: H26xPreset[] = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];

function parsePreset(value: string | undefined): H26xPreset {
    if (value) {
        const normalized = value.trim().toLowerCase() as H26xPreset;
        if (VALID_PRESETS.includes(normalized)) {
            return normalized;
        }
    }
    return "ultrafast";
}

// ===========================================
// Configuration Export
// ===========================================

const config = {
    // Discord self-bot token
    token: process.env.TOKEN || "",

    permissionsFile: parseString(process.env.PERMISSIONS_FILE, ""),

    // Stream settings
    stream: {
        width: parseInt(process.env.STREAM_WIDTH, 1280),
        height: parseInt(process.env.STREAM_HEIGHT, 720),
        fps: parseInt(process.env.STREAM_FPS, 30),
        bitrateKbps: parseInt(process.env.STREAM_BITRATE_KBPS, 2000),
        maxBitrateKbps: parseInt(process.env.STREAM_MAX_BITRATE_KBPS, 2500),
        videoCodec: parseVideoCodec(process.env.STREAM_VIDEO_CODEC),
        h26xPreset: parsePreset(process.env.STREAM_H26X_PRESET),
        hardwareAcceleration: parseBoolean(process.env.STREAM_HARDWARE_ACCELERATION),
    },

    // Chrome/Selenium settings
    browser: {
        display: parseString(process.env.DISPLAY, ":99"),
        extensionPaths: process.env.BROWSER_EXTENSION_PATHS || "",
        defaultUrl: parseString(process.env.DEFAULT_URL, "https://youtube.com/tv"),
        userAgent: parseString(process.env.USER_AGENT, "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36"),
    },

    // Web UI server
    server: {
        enabled: parseBoolean(process.env.SERVER_ENABLED),
        port: parseInt(process.env.SERVER_PORT, 8080),
        host: parseString(process.env.SERVER_HOST, "127.0.0.1"),
    },

    // Confidential Discord application credentials for web login
    oauth: {
        clientId: parseString(process.env.DISCORD_CLIENT_ID, ""),
        clientSecret: parseString(process.env.DISCORD_CLIENT_SECRET, ""),
        redirectUri: parseString(process.env.DISCORD_REDIRECT_URI, ""),
    },

    // Presets
    presets: {
        youtube: parseString(process.env.PRESET_YOUTUBE_URL, "https://youtube.com/tv"),
        plex: parseString(process.env.PRESET_PLEX_URL, "https://app.plex.tv/desktop"),
    },
} as const;

export default config;
export type Config = typeof config;
