import { Client } from "discord.js-selfbot-v13";
import config from "../config.js";
import logger from "../utils/logger.js";

let client: Client | null = null;

/**
 * Initialize and return the Discord selfbot client.
 */
export function createClient(): Client {
    if (client) {
        return client;
    }

    client = new Client();

    client.on("ready", () => {
        logger.info(`Logged in as ${client?.user?.tag}`);
    });

    client.on("error", (error) => {
        logger.error("Discord client error:", error);
    });

    return client;
}

/**
 * Get the current Discord client instance.
 */
export function getClient(): Client | null {
    return client;
}

/**
 * Login to Discord with the configured token.
 */
export async function login(): Promise<void> {
    const c = createClient();
    
    if (!config.token) {
        throw new Error("Discord token not configured. Set TOKEN in .env file.");
    }

    logger.info("Logging in to Discord...");
    await c.login(config.token);
}

/**
 * Logout and destroy the client.
 */
export async function logout(): Promise<void> {
    if (client) {
        client.destroy();
        client = null;
        logger.info("Logged out of Discord");
    }
}

export { Client };
