import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const API = "https://discord.com/api/v10";
const SESSION_COOKIE = "theatre_session";
const STATE_COOKIE = "theatre_oauth_state";
const SCOPES = ["identify", "guilds.members.read"];
const STATE_LIFETIME = 5 * 60_000;
const SESSION_LIFETIME = 8 * 60 * 60_000;

export interface OAuthSettings {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export interface WebSession {
    id: string;
    user: { id: string; username: string };
    accessToken: string;
    expiresAt: number;
    csrf: string;
}

function nonce(): string { return randomBytes(32).toString("hex"); }

function cookie(req: Pick<Request, "headers">, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) return value.join("=");
    }
    return undefined;
}

function equal(a: unknown, b: string): boolean {
    if (typeof a !== "string") return false;
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Confidential Discord OAuth; credentials and bearer tokens stay on the server. */
export class OAuthService {
    public readonly origin: string;
    private readonly secure: boolean;
    private readonly sessionCookie: string;
    private readonly stateCookie: string;
    private readonly sessions = new Map<string, WebSession>();
    private stateKey = randomBytes(32);
    private readonly usedStates = new Map<string, number>();
    private readonly pendingStates = new Set<string>();
    private readonly loginTimes = new Map<string, number[]>();

    constructor(
        private readonly settings: OAuthSettings,
        private readonly request: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
    ) {
        if (!settings.clientId || !settings.clientSecret || !settings.redirectUri) {
            throw new Error("Web controls require DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI");
        }
        const redirect = new URL(settings.redirectUri);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
        if (redirect.username || redirect.password || redirect.search || redirect.hash ||
            redirect.pathname !== "/auth/callback" ||
            (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && loopback))) {
            throw new Error("DISCORD_REDIRECT_URI must be HTTPS (or HTTP on loopback) and end in /auth/callback");
        }
        this.origin = redirect.origin;
        this.secure = redirect.protocol === "https:";
        this.sessionCookie = this.secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
        this.stateCookie = this.secure ? `__Host-${STATE_COOKIE}` : STATE_COOKIE;
    }

    private prune(): void {
        const now = this.now();
        for (const [state, expiry] of this.usedStates) if (expiry <= now) this.usedStates.delete(state);
        for (const [user, times] of this.loginTimes) {
            const recent = times.filter(time => time + STATE_LIFETIME > now);
            if (recent.length) this.loginTimes.set(user, recent); else this.loginTimes.delete(user);
        }
        for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.removeSession(id);
    }

    private setCookie(res: Response, name: string, value: string, maxAge: number, path = "/"): void {
        res.cookie(name, value, { httpOnly: true, sameSite: "lax", secure: this.secure, maxAge, path });
    }

    public begin(res: Response): void {
        this.prune();
        // An abandoned login allocates no shared server-side slot.
        const payload = `${this.now() + STATE_LIFETIME}.${nonce()}`;
        const state = `${payload}.${createHmac("sha256", this.stateKey).update(payload).digest("hex")}`;
        this.setCookie(res, this.stateCookie, state, STATE_LIFETIME, this.secure ? "/" : "/auth/callback");
        const url = new URL("https://discord.com/oauth2/authorize");
        url.search = new URLSearchParams({
            client_id: this.settings.clientId, redirect_uri: this.settings.redirectUri,
            response_type: "code", scope: SCOPES.join(" "), state,
        }).toString();
        res.redirect(url.toString());
    }

    private async discord(path: string, accessToken: string): Promise<unknown> {
        const response = await this.request(`${API}${path}`, {
            headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Discord identity verification failed");
        return response.json();
    }

    /** Verify signed browser-bound state; successful callbacks cannot be replayed. */
    public async callback(req: Request, res: Response): Promise<void> {
        this.prune();
        const state = req.query.state;
        const browserState = cookie(req, this.stateCookie);
        const stateKey = this.stateKey;
        const parts = typeof state === "string" ? state.split(".") : [];
        const expiry = Number(parts[0]);
        const payload = parts.slice(0, 2).join(".");
        if (typeof state !== "string" || !browserState || !equal(state, browserState) ||
            parts.length !== 3 || !/^\d+$/.test(parts[0] ?? "") || !/^[0-9a-f]{64}$/.test(parts[1] ?? "") ||
            !Number.isSafeInteger(expiry) || expiry <= this.now() || expiry > this.now() + STATE_LIFETIME ||
            !equal(parts[2], createHmac("sha256", stateKey).update(payload).digest("hex")) ||
            this.usedStates.has(state) || this.pendingStates.has(state)) {
            throw new Error("Login expired or state did not match; sign in again");
        }
        this.pendingStates.add(state);
        try {
            this.setCookie(res, this.stateCookie, "", 0, this.secure ? "/" : "/auth/callback");
            if (typeof req.query.code !== "string" || !req.query.code || req.query.error) {
                throw new Error("Discord login was not completed");
            }
            const response = await this.request(`${API}/oauth2/token`, {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: this.settings.clientId, client_secret: this.settings.clientSecret,
                    grant_type: "authorization_code", code: req.query.code, redirect_uri: this.settings.redirectUri,
                }), signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error("Discord login exchange failed");
            const token = await response.json() as Record<string, unknown>;
            if (typeof token.access_token !== "string" || !token.access_token ||
                typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
                typeof token.scope !== "string" || !SCOPES.every(scope => (token.scope as string).split(" ").includes(scope))) {
                throw new Error("Discord login did not grant the required identity and membership scopes");
            }
            const user = await this.discord("/users/@me", token.access_token) as Record<string, unknown>;
            if (typeof user.id !== "string" || !/^\d{1,20}$/.test(user.id) || typeof user.username !== "string") {
                throw new Error("Discord returned an invalid identity");
            }
            if (this.stateKey !== stateKey) throw new Error("Login expired; sign in again");
            this.prune();
            const recent = this.loginTimes.get(user.id) ?? [];
            if (recent.length >= 10) throw new Error("Too many logins for this account; retry shortly");
            this.loginTimes.set(user.id, [...recent, this.now()]);
            this.usedStates.set(state, expiry);
            // Limit one account to three sessions and evict rather than block unrelated logins.
            const owned = [...this.sessions.values()].filter(session => session.user.id === user.id);
            while (owned.length >= 3) this.removeSession(owned.shift()!.id);
            while (this.sessions.size >= 1000) this.removeSession(this.sessions.keys().next().value!);
            const lifetime = Math.min(token.expires_in * 1000, SESSION_LIFETIME);
            const session: WebSession = {
                id: nonce(), user: { id: user.id, username: user.username }, accessToken: token.access_token,
                csrf: nonce(), expiresAt: this.now() + lifetime,
            };
            const previous = cookie(req, this.sessionCookie);
            if (previous) this.removeSession(previous);
            this.sessions.set(session.id, session);
            this.setCookie(res, this.sessionCookie, session.id, lifetime);
            res.redirect("/");
        } finally { this.pendingStates.delete(state); }
    }

    public session(req: Pick<Request, "headers">): WebSession | undefined {
        this.prune();
        const id = cookie(req, this.sessionCookie);
        return id ? this.sessions.get(id) : undefined;
    }

    public valid(session: WebSession): boolean {
        return this.sessions.get(session.id) === session && session.expiresAt > this.now();
    }

    public sameOrigin(origin: unknown): boolean { return origin === this.origin; }

    public csrf(session: WebSession, value: unknown): boolean {
        return this.valid(session) && equal(value, session.csrf);
    }

    private removeSession(id: string): void {
        this.sessions.delete(id);
    }

    public logout(req: Request, res: Response): void {
        const id = cookie(req, this.sessionCookie);
        if (id) this.removeSession(id);
        this.setCookie(res, this.sessionCookie, "", 0);
    }

    public close(): void {
        this.stateKey = randomBytes(32);
        this.sessions.clear();
        this.usedStates.clear();
        this.pendingStates.clear();
        this.loginTimes.clear();
    }
}
