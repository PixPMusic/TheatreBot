import express, { type Request, type Response } from "express";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath } from "node:url";
import type { BrowserControls } from "../browser/controls.js";
import { validateNavigationUrl } from "../browser/url.js";
import type { NavigationKey } from "../types/index.js";
import { WebAccessError, type AuthorizedView } from "./authorization.js";
import { OAuthService, type WebSession } from "./oauth.js";
import { streamClaims, type StreamClaims } from "./claims.js";

type Capability = "control" | "navigate";
const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Backspace", "Tab", "Space"]);
type Controls = Pick<BrowserControls, "getCurrentUrl" | "getCurrentPreset" | "getPresets" | "navigateTo" | "navigateToPreset" | "sendKey" | "search" | "submitSearch" | "goBack" | "refresh">;

/** Create an isolated HTTP/Socket.IO instance with the same gates for both transports. */
export function createWebServer(oauth: OAuthService, authorize: ((session: WebSession) => Promise<AuthorizedView>) & { close?: () => void }, controls: Controls, claims: Pick<StreamClaims, "claim"> = streamClaims) {
    const app = express();
    const server = createServer(app);
    const trustedRequest = (req: IncomingMessage): boolean => {
        if (req.headers.origin) return oauth.sameOrigin(req.headers.origin);
        // Same-origin browser polling GETs omit Origin. Cross-site pages cannot forge
        // Sec-Fetch-Site/Referer; socket authentication still requires cookie + CSRF.
        if (req.headers["sec-fetch-site"] !== "same-origin" || !req.headers.referer) return false;
        try { return oauth.sameOrigin(new URL(req.headers.referer).origin); } catch { return false; }
    };
    const io = new SocketIOServer(server, {
        allowRequest: (req, done) => done(null, trustedRequest(req)),
    });
    io.engine.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (trustedRequest(req)) { next(); return; }
        res.writeHead(403); res.end("Origin denied");
    });
    app.use((_req, res, next) => {
        res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        next();
    });
    app.use(express.json({ limit: "16kb" }));
    const error = (res: Response, cause: unknown) => {
        if (cause instanceof WebAccessError && cause.retryAfter) res.set("Retry-After", String(cause.retryAfter));
        res.status(cause instanceof WebAccessError ? cause.status : 503)
            .json({ error: cause instanceof WebAccessError ? cause.message : "Unable to complete this action; retry or sign in again" });
    };
    const login = (req: Request): WebSession => {
        const session = oauth.session(req);
        if (!session) throw new WebAccessError(401, "Sign in with Discord");
        return session;
    };
    const write = (req: Request, session: WebSession) => {
        if (!oauth.sameOrigin(req.headers.origin) || !oauth.csrf(session, req.headers["x-csrf-token"])) {
            throw new WebAccessError(403, "Request origin or CSRF token did not match");
        }
    };
    app.get("/auth/login", (_req, res) => { try { oauth.begin(res); } catch { res.status(503).send("Login unavailable; retry shortly"); } });
    app.get("/auth/callback", async (req, res) => {
        try { await oauth.callback(req, res); }
        catch { res.status(400).send('Discord login failed or expired. <a href="/auth/login">Sign in again</a>.'); }
    });
    app.post("/auth/logout", (req, res) => {
        try {
            const session = login(req); write(req, session); oauth.logout(req, res);
            for (const socket of io.sockets.sockets.values()) if (socket.data.session === session) socket.disconnect(true);
            res.json({ success: true });
        } catch (cause) { error(res, cause); }
    });
    app.get("/claim/:id", (req, res) => {
        if (!/^[a-f0-9]{64}$/.test(String(req.params.id))) { res.status(404).send("Unknown claim"); return; }
        res.sendFile(fileURLToPath(new URL("../../public/claim.html", import.meta.url)));
    });
    app.post("/api/claim/:id", async (req, res) => {
        try {
            const session = login(req); write(req, session);
            await claims.claim(String(req.params.id), session, () => oauth.valid(session));
            res.json({ success: true });
        } catch (cause) { error(res, cause); }
    });
    app.get("/api/auth/session", async (req, res) => {
        const session = oauth.session(req);
        if (!session) { res.json({ authenticated: false }); return; }
        let access: AuthorizedView | undefined;
        let accessError = "";
        let accessStatus = 200;
        let retryAfter: number | undefined;
        try { access = await authorize(session); }
        catch (cause) {
            accessError = cause instanceof WebAccessError ? cause.message : "Unable to verify access";
            accessStatus = cause instanceof WebAccessError ? cause.status : 503;
            retryAfter = cause instanceof WebAccessError ? cause.retryAfter : undefined;
        }
        if (!oauth.valid(session)) { res.json({ authenticated: false }); return; }
        res.json({ authenticated: true, user: session.user, csrf: session.csrf,
            capabilities: access?.capabilities ?? { control: false, navigate: false }, accessError, accessStatus, retryAfter });
    });
    app.get("/api/status", async (req, res) => {
        try {
            const access = await authorize(login(req));
            const currentUrl = await controls.getCurrentUrl().catch(() => null);
            // Navigation lookup may wait on Selenium; recheck scope before releasing metadata.
            const verified = await authorize(login(req));
            if (verified.session !== access.session) throw new WebAccessError(409, "Session changed; refresh");
            res.json({ browser: { currentUrl, currentPreset: controls.getCurrentPreset() }, stream: verified.stream, sessions: [verified.session] });
        } catch (cause) { error(res, cause); }
    });
    app.get("/api/presets", async (req, res) => {
        try { await authorize(login(req)); res.json(controls.getPresets()); }
        catch (cause) { error(res, cause); }
    });

    const execute = async (action: string, body: Record<string, unknown>) => {
        switch (action) {
            case "navigate": {
                let url: string;
                try { url = validateNavigationUrl(body.url); }
                catch { throw new WebAccessError(400, "Enter an HTTP or HTTPS URL without embedded credentials"); }
                await controls.navigateTo(url);
                return { event: "urlChanged", data: { url } };
            }
            case "preset": {
                if (typeof body.id !== "string") throw new WebAccessError(400, "Preset required");
                const preset = controls.getPresets().find(p => p.id === body.id);
                if (!preset) throw new WebAccessError(400, "Unknown preset");
                validateNavigationUrl(preset.url);
                await controls.navigateToPreset(body.id);
                return { event: "presetChanged", data: { preset: controls.getCurrentPreset() } };
            }
            case "key":
                if (typeof body.key !== "string" || !KEYS.has(body.key)) throw new WebAccessError(400, "Unknown navigation key");
                await controls.sendKey(body.key as NavigationKey); break;
            case "search":
                if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 1000 ||
                    (body.submit !== undefined && typeof body.submit !== "boolean")) throw new WebAccessError(400, "Search text required");
                if (body.submit) await controls.submitSearch(body.query); else await controls.search(body.query); break;
            case "back": await controls.goBack(); break;
            case "refresh": await controls.refresh(); break;
        }
        return undefined;
    };
    const check = async (session: WebSession, capability: Capability) => {
        if (!oauth.valid(session)) throw new WebAccessError(401, "Sign in with Discord again");
        const view = await authorize(session);
        if (!view.capabilities[capability]) throw new WebAccessError(403, `You need ${capability} permission for this session`);
        return view;
    };
    const notify = async (change: { event: string; data: unknown } | undefined, session: AuthorizedView["session"]) => {
        if (!change) return;
        for (const socket of io.sockets.sockets.values()) {
            try {
                const peer = socket.data.session as WebSession;
                if (!oauth.valid(peer)) { socket.disconnect(true); continue; }
                const view = await authorize(peer);
                if (view.session === session) socket.emit(change.event, change.data);
            } catch { /* Participants who have left the session receive no browser metadata. */ }
        }
    };
    for (const action of ["navigate", "preset", "key", "search", "back", "refresh"]) {
        const capability: Capability = action === "navigate" ? "navigate" : "control";
        app.post(action === "preset" ? "/api/preset/:id" : `/api/${action}`, async (req: Request, res: Response) => {
            try {
                const session = login(req); write(req, session);
                const view = await check(session, capability);
                const body = req.body && typeof req.body === "object" ? req.body : {};
                const change = await execute(action, { ...body, ...(action === "preset" ? { id: req.params.id } : {}) });
                res.json({ success: true });
                await notify(change, view.session);
            } catch (cause) { if (!res.headersSent) error(res, cause); }
        });
    }
    io.use(async (socket, next) => {
        try {
            const session = oauth.session({ headers: socket.request.headers });
            if (!session || !trustedRequest(socket.request) || !oauth.csrf(session, socket.handshake.auth.csrf)) {
                throw new Error("Sign in with Discord from this site's control page");
            }
            await authorize(session);
            socket.data.session = session;
            next();
        } catch { next(new Error("Sign in and join an authorized streaming session")); }
    });
    io.on("connection", socket => {
        const session = socket.data.session as WebSession;
        socket.emit("connected", { socketId: socket.id });
        for (const action of ["key", "navigate", "preset", "search"]) {
            socket.on(action, async payload => {
                try {
                    const view = await check(session, action === "navigate" ? "navigate" : "control");
                    const body = action === "key" ? { key: payload } : action === "navigate" ? { url: payload } :
                        action === "preset" ? { id: payload } : payload;
                    if (!body || typeof body !== "object") throw new WebAccessError(400, "Invalid control payload");
                    const change = await execute(action, body);
                    if (action === "key" || action === "search") socket.emit(`${action}Ack`, { success: true });
                    await notify(change, view.session);
                } catch (cause) {
                    socket.emit("error", { message: cause instanceof WebAccessError ? cause.message : "Control failed" });
                    if (!oauth.valid(session)) socket.disconnect(true);
                }
            });
        }
    });
    app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url))));
    return { server, io, close: () => {
        authorize.close?.();
        return new Promise<void>(resolve => io.close(() => { oauth.close(); resolve(); }));
    } };
}
