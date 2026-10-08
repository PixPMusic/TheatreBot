import config from "../config.js";
import logger from "../utils/logger.js";
import { getBrowserControls } from "../browser/controls.js";
import { OAuthService } from "./oauth.js";
import { createAuthorization } from "./authorization.js";
import { streamClaims, resetClaimVerification } from "./claims.js";
import { createWebServer } from "./web.js";

let active: ReturnType<typeof createWebServer> | null = null;

/** Validate enabled web login before any Discord connection is opened. */
export function validateServerConfiguration(): void {
    if (!config.server.enabled) throw new Error("Streaming requires SERVER_ENABLED=true and Discord OAuth login");
    new OAuthService(config.oauth).close();
}

/** Listen only after OAuth configuration and all HTTP/Socket.IO guards are installed. */
export async function startServer(): Promise<void> {
    if (active) return;
    const oauth = new OAuthService(config.oauth);
    const authorize = createAuthorization(oauth);
    const instance = createWebServer(oauth, authorize, getBrowserControls());
    active = instance;
    try {
        await new Promise<void>((resolve, reject) => {
            instance.server.once("error", reject);
            instance.server.listen(config.server.port, config.server.host, () => {
                instance.server.off("error", reject);
                resolve();
            });
        });
        logger.info(`Web UI server running at ${oauth.origin}`);
    } catch (error) {
        active = null;
        authorize.close();
        await instance.close();
        throw error;
    }
}

/** Close live Socket.IO clients as well as HTTP and dispose in-memory login state. */
export async function stopServer(): Promise<void> {
    const instance = active;
    if (instance) {
        await streamClaims.stop();
        resetClaimVerification();
        await instance.close();
        if (active === instance) active = null;
        logger.info("Web UI server stopped");
    }
}
