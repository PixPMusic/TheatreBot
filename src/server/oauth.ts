import { randomBytes, timingSafeEqual } from "node:crypto";
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

interface Membership { roles: string[]; }
interface CachedMembership { expiresAt: number; value: Membership; }

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
    private readonly states = new Map<string, number>();
    private readonly memberships = new Map<string, CachedMembership>();
    private readonly pendingMemberships = new Map<string, Promise<Membership>>();

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
        for (const [state, expiry] of this.states) if (expiry <= now) this.states.delete(state);
        for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.removeSession(id);
        for (const [key, entry] of this.memberships) if (entry.expiresAt <= now) this.memberships.delete(key);
    }

    private setCookie(res: Response, name: string, value: string, maxAge: number, path = "/"): void {
        res.cookie(name, value, { httpOnly: true, sameSite: "lax", secure: this.secure, maxAge, path });
    }

    public begin(res: Response): void {
        this.prune();
        if (this.states.size >= 500) throw new Error("Too many pending logins; retry shortly");
        const state = nonce();
        this.states.set(state, this.now() + STATE_LIFETIME);
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
        if (!response.ok) throw new Error("Discord identity or membership verification failed");
        return response.json();
    }

    /** Validate browser-bound, single-use state before exchanging any authorization code. */
    public async callback(req: Request, res: Response): Promise<void> {
        this.prune();
        const state = req.query.state;
        const browserState = cookie(req, this.stateCookie);
        if (typeof state !== "string" || !browserState || !equal(state, browserState) || !this.states.has(state)) {
            throw new Error("Login expired or state did not match; sign in again");
        }
        this.states.delete(state);
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
        this.prune();
        if (this.sessions.size >= 1000) throw new Error("Too many signed-in sessions; retry shortly");
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
        for (const key of this.memberships.keys()) if (key.startsWith(`${id}:`)) this.memberships.delete(key);
    }

    public logout(req: Request, res: Response): void {
        const id = cookie(req, this.sessionCookie);
        if (id) this.removeSession(id);
        this.setCookie(res, this.sessionCookie, "", 0);
    }

    /** Cache proven roles for at most 30 seconds; voice/session checks still run on every action. */
    public async membership(session: WebSession, guildId: string): Promise<Membership> {
        if (!this.valid(session) || !/^\d{1,20}$/.test(guildId)) throw new Error("Sign in again");
        const key = `${session.id}:${guildId}`;
        const cached = this.memberships.get(key);
        if (cached && cached.expiresAt > this.now()) return cached.value;
        let pending = this.pendingMemberships.get(key);
        if (!pending) {
            pending = this.discord(`/users/@me/guilds/${guildId}/member`, session.accessToken).then(raw => {
                const member = raw as Record<string, unknown>;
                if (!Array.isArray(member.roles) || !member.roles.every(role => typeof role === "string" && /^\d{1,20}$/.test(role))) {
                    throw new Error("Discord returned invalid membership roles");
                }
                const value = { roles: member.roles as string[] };
                if (this.valid(session)) this.memberships.set(key, { value, expiresAt: this.now() + 30_000 });
                return value;
            }).finally(() => this.pendingMemberships.delete(key));
            this.pendingMemberships.set(key, pending);
        }
        const member = await pending;
        if (!this.valid(session)) throw new Error("Sign in again");
        return member;
    }

    public close(): void {
        this.sessions.clear();
        this.states.clear();
        this.memberships.clear();
    }
}
