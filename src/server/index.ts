import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import config from "../config.js";
import logger from "../utils/logger.js";
import { getBrowserControls } from "../browser/controls.js";
import { getStreamingService } from "../discord/streaming.js";
import type { BrowserAction, NavigationKey, Preset } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let server: ReturnType<typeof createServer> | null = null;
let io: SocketIOServer | null = null;

/**
 * Start the web UI server.
 */
export async function startServer(): Promise<void> {
    if (server) {
        logger.warn("Server already running");
        return;
    }

    const app = express();
    server = createServer(app);
    io = new SocketIOServer(server);

    // Serve static files
    const publicPath = path.join(__dirname, "../../public");
    app.use(express.static(publicPath));
    app.use(express.json());

    // API routes
    setupRoutes(app);

    // WebSocket handlers
    setupSocketHandlers(io);

    // Start listening
    server.listen(config.server.port, () => {
        logger.info(`Web UI server running at http://localhost:${config.server.port}`);
    });
}

/**
 * Setup Express routes.
 */
function setupRoutes(app: express.Application): void {
    // Get current state
    app.get("/api/status", async (req, res) => {
        try {
            const controls = getBrowserControls();
            const streaming = getStreamingService();
            
            res.json({
                browser: {
                    currentUrl: await controls.getCurrentUrl().catch(() => null),
                    currentPreset: controls.getCurrentPreset(),
                },
                stream: streaming ? streaming.getStatus() : null,
                sessions: streaming ? streaming.getAllSessions() : [],
            });
        } catch (error) {
            res.status(500).json({ error: "Failed to get status" });
        }
    });

    // Get available presets
    app.get("/api/presets", (req, res) => {
        const controls = getBrowserControls();
        res.json(controls.getPresets());
    });

    // Navigate to URL
    app.post("/api/navigate", async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: "URL required" });
            }

            const controls = getBrowserControls();
            await controls.navigateTo(url);
            
            res.json({ success: true, url });
        } catch (error) {
            res.status(500).json({ error: "Navigation failed" });
        }
    });

    // Navigate to preset
    app.post("/api/preset/:id", async (req, res) => {
        try {
            const { id } = req.params;
            const controls = getBrowserControls();
            await controls.navigateToPreset(id);
            
            res.json({ success: true, presetId: id });
        } catch (error) {
            res.status(500).json({ error: "Preset navigation failed" });
        }
    });

    // Send key
    app.post("/api/key", async (req, res) => {
        try {
            const { key } = req.body as { key: NavigationKey };
            if (!key) {
                return res.status(400).json({ error: "Key required" });
            }

            const controls = getBrowserControls();
            await controls.sendKey(key);
            
            res.json({ success: true, key });
        } catch (error) {
            res.status(500).json({ error: "Key send failed" });
        }
    });

    // Search
    app.post("/api/search", async (req, res) => {
        try {
            const { query, submit } = req.body;
            if (!query) {
                return res.status(400).json({ error: "Query required" });
            }

            const controls = getBrowserControls();
            if (submit) {
                await controls.submitSearch(query);
            } else {
                await controls.search(query);
            }
            
            res.json({ success: true, query });
        } catch (error) {
            res.status(500).json({ error: "Search failed" });
        }
    });

    // Browser actions (back, refresh)
    app.post("/api/back", async (req, res) => {
        try {
            const controls = getBrowserControls();
            await controls.goBack();
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: "Back navigation failed" });
        }
    });

    app.post("/api/refresh", async (req, res) => {
        try {
            const controls = getBrowserControls();
            await controls.refresh();
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: "Refresh failed" });
        }
    });
}

/**
 * Setup Socket.IO handlers for real-time control.
 */
function setupSocketHandlers(io: SocketIOServer): void {
    io.on("connection", (socket) => {
        logger.info(`Client connected: ${socket.id}`);

        // Send initial state
        socket.emit("connected", { socketId: socket.id });

        // Handle key press
        socket.on("key", async (key: NavigationKey) => {
            try {
                const controls = getBrowserControls();
                await controls.sendKey(key);
                socket.emit("keyAck", { key, success: true });
            } catch (error) {
                socket.emit("keyAck", { key, success: false });
            }
        });

        // Handle navigation
        socket.on("navigate", async (url: string) => {
            try {
                const controls = getBrowserControls();
                await controls.navigateTo(url);
                io.emit("urlChanged", { url });
            } catch (error) {
                socket.emit("error", { message: "Navigation failed" });
            }
        });

        // Handle preset navigation
        socket.on("preset", async (presetId: string) => {
            try {
                const controls = getBrowserControls();
                await controls.navigateToPreset(presetId);
                const preset = controls.getCurrentPreset();
                io.emit("presetChanged", { preset });
            } catch (error) {
                socket.emit("error", { message: "Preset navigation failed" });
            }
        });

        // Handle search
        socket.on("search", async ({ query, submit }: { query: string; submit?: boolean }) => {
            try {
                const controls = getBrowserControls();
                if (submit) {
                    await controls.submitSearch(query);
                } else {
                    await controls.search(query);
                }
                socket.emit("searchAck", { query, success: true });
            } catch (error) {
                socket.emit("searchAck", { query, success: false });
            }
        });

        // Handle disconnect
        socket.on("disconnect", () => {
            logger.info(`Client disconnected: ${socket.id}`);
        });
    });
}

/**
 * Broadcast an event to all connected clients.
 */
export function broadcast(event: string, data: unknown): void {
    if (io) {
        io.emit(event, data);
    }
}

/**
 * Stop the server.
 */
export async function stopServer(): Promise<void> {
    if (server) {
        server.close();
        server = null;
        io = null;
        logger.info("Web UI server stopped");
    }
}
