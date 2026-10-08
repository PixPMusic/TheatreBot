import config from "./config.js";
import logger from "./utils/logger.js";
import { login, getClient } from "./discord/client.js";
import { initStreamingService, getStreamingService } from "./discord/streaming.js";
import { setupCommands } from "./discord/commands.js";
import { getBrowserControls } from "./browser/controls.js";
import { getCaptureService } from "./browser/capture.js";
import { startServer, stopServer } from "./server/index.js";

/**
 * Theatre Bot - Main Entry Point
 * 
 * A Discord self-bot that streams Chrome browser content to voice channels,
 * controllable via a remote web UI.
 */
async function main(): Promise<void> {
    logger.info("=".repeat(50));
    logger.info("Theatre Bot Starting...");
    logger.info("=".repeat(50));

    // Validate configuration
    if (!config.token) {
        logger.error("Discord token not configured. Copy .env.example to .env and set TOKEN.");
        process.exit(1);
    }

    try {
        // 1. Login to Discord
        await login();
        const client = getClient();
        
        if (!client) {
            throw new Error("Failed to get Discord client after login");
        }

        // 2. Initialize streaming service
        const streamingService = initStreamingService(client);
        logger.info("Streaming service initialized");

        // 3. Setup Discord message commands
        setupCommands();

        // 4. Start web UI server if enabled
        if (config.server.enabled) {
            await startServer();
        }

        logger.info("=".repeat(50));
        logger.info("Theatre Bot Ready!");
        logger.info("=".repeat(50));
        logger.info("");
        logger.info("Usage:");
        logger.info("  1. Use Discord commands to join a voice channel");
        logger.info("  2. The bot will start Chrome and begin streaming");
        logger.info("  3. Control the browser via the web UI or Discord");
        logger.info("");
        if (config.server.enabled) {
            logger.info(`Web UI: http://localhost:${config.server.port}`);
        }

    } catch (error) {
        logger.error("Failed to start Theatre Bot:", error);
        process.exit(1);
    }
}

/** Stop owned playback and capture before closing browser/server resources. */
async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);
    try {
        getStreamingService()?.cleanup();
        getCaptureService().stopCapture();
        await stopServer();
        await getBrowserControls().close();
    } catch (error) {
        logger.error("Error during shutdown:", error);
    }
    process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled rejection at:", promise, "reason:", reason);
});

// Run
main();
