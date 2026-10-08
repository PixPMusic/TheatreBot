import type { Guild } from "@lng2004/discord.js-selfbot-v13";
import { getClient } from "../discord/client.js";
import { getStreamingService } from "../discord/streaming.js";
import { canControlSession, canNavigate, type PermissionSubject } from "../rbac/permissions.js";
import type { Session, StreamStatus } from "../types/index.js";
import type { OAuthService, WebSession } from "./oauth.js";

export class WebAccessError extends Error {
    constructor(public readonly status: number, message: string, public readonly retryAfter?: number) { super(message); }
}

export interface AuthorizedView {
    session: Session;
    stream: StreamStatus;
    capabilities: { control: boolean; navigate: boolean };
}

export type Authorizer = ((login: WebSession) => Promise<AuthorizedView>) & { close(): void };
const delayed = () => new WebAccessError(503, "Discord verification is delayed; controls will retry automatically", 10);
const denied = () => new WebAccessError(403, "Discord could not verify membership in this session's server");
const ID = /^\d{1,20}$/;
const MAX_MEMBERSHIPS = 1000;

/** OAuth proves identity; the existing Discord connection proves fresh guild roles. */
export function createAuthorization(
    oauth: OAuthService,
    { now = Date.now, timeoutMs = 10_000 }: { now?: () => number; timeoutMs?: number } = {},
): Authorizer {
    // Tie proof to the connection and guild that fetched it, never a browser token.
    const memberships = new Map<string, { roles: string[]; expiresAt: number; client: ReturnType<typeof getClient>; guild: Guild }>();
    const pending = new Map<string, Promise<string[]>>();
    let closed = false;
    const authorize = async (login: WebSession): Promise<AuthorizedView> => {
        if (closed || !oauth.valid(login)) throw new WebAccessError(401, "Sign in with Discord again");
        const streaming = getStreamingService();
        const client = getClient();
        const stream = streaming?.getStatus();
        if (!streaming || !client || !stream?.joined || !stream.channelInfo) {
            throw new WebAccessError(409, "Start a stream with !join and join its voice channel first");
        }
        const { guildId, channelId } = stream.channelInfo;
        const userId = login.user.id;
        const active = streaming.getSession(`${guildId}-${channelId}`);
        const guild = client.guilds.cache.get(guildId);
        if (!active || !guild || !ID.test(guildId) || !ID.test(userId)) throw denied();
        if (guild.voiceStates.cache.get(userId)?.channelId !== channelId) {
            throw new WebAccessError(403, "Join this stream's voice channel and request control permission from its server owner");
        }
        for (const [key, value] of memberships) if (value.expiresAt <= now()) memberships.delete(key);
        const key = `${guildId}:${userId}`;
        const cached = memberships.get(key);
        let roleIds: string[];
        if (cached && cached.client === client && cached.guild === guild) {
            roleIds = cached.roles;
        } else {
            let work = pending.get(key);
            if (!work) {
                if (pending.size >= MAX_MEMBERSHIPS) throw delayed();
                work = Promise.resolve().then(() => guild.members.fetch({ user: userId, force: true })).then(member => {
                    if (!member || member.id !== userId || member.guild?.id !== guildId || member.partial !== false ||
                        !member.roles?.cache || ![...member.roles.cache.keys()].every(id => typeof id === "string" && ID.test(id))) {
                        throw denied();
                    }
                    const roles = [...member.roles.cache.keys()];
                    if (closed || getClient() !== client || client.guilds.cache.get(guildId) !== guild) {
                        throw new WebAccessError(409, "The Discord connection changed; reconnect");
                    }
                    if (oauth.valid(login)) {
                        if (memberships.size >= MAX_MEMBERSHIPS) memberships.delete(memberships.keys().next().value!);
                        memberships.set(key, { roles, expiresAt: now() + 30_000, client, guild });
                    }
                    return roles;
                }).catch(cause => {
                    if (cause instanceof WebAccessError) throw cause;
                    if (cause && typeof cause === "object" && "code" in cause && cause.code === 10007) throw denied();
                    throw delayed();
                }).finally(() => { if (pending.get(key) === work) pending.delete(key); });
                pending.set(key, work);
            }
            // The library owns Discord's retry queue. Timing out a browser request
            // leaves that work shared, so polling cannot enqueue duplicate fetches.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                roleIds = await Promise.race([work, new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(delayed()), timeoutMs);
                })]);
            } finally { if (timer) clearTimeout(timer); }
        }

        // Every await may outlive login, connection, voice membership or session.
        if (closed || !oauth.valid(login)) throw new WebAccessError(401, "Sign in with Discord again");
        const current = streaming.getStatus();
        if (getClient() !== client || getStreamingService() !== streaming || client.guilds.cache.get(guildId) !== guild ||
            !current.joined || current.channelInfo?.guildId !== guildId || current.channelInfo.channelId !== channelId ||
            streaming.getSession(active.id) !== active) {
            throw new WebAccessError(409, "The streaming session changed; reconnect");
        }
        const roles = new Set([guildId, ...roleIds]);
        const subject: PermissionSubject = {
            id: userId,
            guild: { id: guildId, ownerId: guild.ownerId },
            voice: { channelId: guild.voiceStates.cache.get(userId)?.channelId ?? null },
            roles: { cache: roles },
            permissions: { has: () => [...roles].some(id => guild.roles.cache.get(id)?.permissions.has("ADMINISTRATOR")) },
        };
        const capabilities = {
            control: canControlSession(subject, active),
            navigate: canNavigate(subject, active, false),
        };
        if (!capabilities.control && !capabilities.navigate) {
            throw new WebAccessError(403, "Join this stream's voice channel and request control permission from its server owner");
        }
        return { session: active, stream: current, capabilities };
    };
    return Object.assign(authorize, { close() { closed = true; memberships.clear(); pending.clear(); } });
}
