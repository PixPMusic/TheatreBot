import type { Guild } from '@lng2004/discord.js-selfbot-v13';
import { getClient } from '../discord/client.js';
import { getStreamingService } from '../discord/streaming.js';
import { hasPermission, type PermissionSubject } from '../rbac/permissions.js';
import type { Session, StreamStatus } from '../types/index.js';
import type { OAuthService, WebSession } from './oauth.js';

export class WebAccessError extends Error {
    constructor(public readonly status: number, message: string, public readonly retryAfter?: number) { super(message); }
}
export interface AuthorizedView { session: Session; stream: StreamStatus; capabilities: { control: boolean; navigate: boolean } }
export type Authorizer = ((login: WebSession) => Promise<AuthorizedView>) & { close(): void };
const ID = /^\d{1,20}$/;
const delayed = () => new WebAccessError(503, 'Discord verification is delayed; retry shortly', 10);

/** Share library-managed fetches and bounded, copied role proofs tied to the exact Discord connection. */
export function createMemberVerification({ timeoutMs = 10_000, now = Date.now }: { timeoutMs?: number; now?: () => number } = {}) {
    const pending = new Map<string, { guild: Guild; client: ReturnType<typeof getClient>; work: Promise<string[]> }>();
    const proofs = new Map<string, { guild: Guild; client: ReturnType<typeof getClient>; roles: string[]; expiresAt: number }>();
    let closed = false;
    const verify = async (userId: string, guildId: string, channelId: string, { fresh = false, valid = () => true }: { fresh?: boolean; valid?: () => boolean } = {}): Promise<PermissionSubject> => {
        const client = getClient();
        const guild = client?.guilds.cache.get(guildId);
        if (closed || !client || !guild || !ID.test(userId) || !ID.test(guildId) ||
            guild.voiceStates.cache.get(userId)?.channelId !== channelId) throw new WebAccessError(403, 'Join the requested voice channel in this server');
        for (const [key, proof] of proofs) if (proof.expiresAt <= now()) proofs.delete(key);
        const key = `${guildId}:${userId}`;
        const cached = proofs.get(key);
        let roles: string[] | undefined = !fresh && cached?.client === client && cached.guild === guild ? cached.roles : undefined;
        if (!roles) {
            let entry = pending.get(key);
            if (!entry || entry.guild !== guild || entry.client !== client) {
                if (pending.size >= 1000) throw delayed();
                const work = Promise.resolve().then(() => guild.members.fetch({ user: userId, force: true })).then(member => {
                    if (!member || member.id !== userId || member.guild?.id !== guildId || member.partial !== false ||
                        !member.roles?.cache || ![...member.roles.cache.keys()].every(id => typeof id === 'string' && ID.test(id))) {
                        throw new WebAccessError(403, 'Discord could not verify server membership');
                    }
                    const roles = [...member.roles.cache.keys()];
                    if (closed || getClient() !== client || client.guilds.cache.get(guildId) !== guild) throw new WebAccessError(409, 'Discord connection changed; reconnect');
                    if (valid()) {
                        if (proofs.size >= 1000) proofs.delete(proofs.keys().next().value!);
                        proofs.set(key, { roles, expiresAt: now() + 30_000, guild, client });
                    }
                    return roles;
                }).catch(cause => {
                    if (cause instanceof WebAccessError) throw cause;
                    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 10007) throw new WebAccessError(403, 'Discord could not verify server membership');
                    throw delayed();
                }).finally(() => { if (pending.get(key)?.work === work) pending.delete(key); });
                entry = { guild, client, work }; pending.set(key, entry);
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { roles = await Promise.race([entry.work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(delayed()), timeoutMs); })]); }
            finally { if (timer) clearTimeout(timer); }
        }
        if (closed || getClient() !== client || client.guilds.cache.get(guildId) !== guild) throw new WebAccessError(409, 'Discord connection changed; reconnect');
        if (guild.voiceStates.cache.get(userId)?.channelId !== channelId) throw new WebAccessError(403, 'Join the requested voice channel in this server');
        const roleSet = new Set([guildId, ...roles]);
        return { id: userId, guild: { id: guildId, ownerId: guild.ownerId }, voice: { channelId },
            roles: { cache: roleSet }, permissions: { has: () => [...roleSet].some(id => guild.roles.cache.get(id)?.permissions.has('ADMINISTRATOR')) } };
    };
    return Object.assign(verify, { close() { closed = true; pending.clear(); proofs.clear(); } });
}

/** A personal browser belongs only to its owner with a current join entitlement. */
export function createAuthorization(oauth: OAuthService, options: { now?: () => number; timeoutMs?: number } = {}): Authorizer {
    const verify = createMemberVerification(options);
    let closed = false;
    const authorize = async (login: WebSession): Promise<AuthorizedView> => {
        if (closed || !oauth.valid(login)) throw new WebAccessError(401, 'Sign in with Discord again');
        const streaming = getStreamingService();
        const stream = streaming?.getStatus();
        if (!streaming || !stream?.joined || !stream.channelInfo) throw new WebAccessError(409, 'Request a stream with !join and claim it first');
        const { guildId, channelId } = stream.channelInfo;
        const session = streaming.getSession(`${guildId}-${channelId}`);
        if (!session || session.startedBy !== login.user.id) throw new WebAccessError(403, 'Only the browser owner can read or operate this profile');
        const subject = await verify(login.user.id, guildId, channelId, { valid: () => oauth.valid(login) });
        if (closed || !oauth.valid(login)) throw new WebAccessError(401, 'Sign in with Discord again');
        const current = streaming.getStatus();
        if (getStreamingService() !== streaming || !current.joined || current.channelInfo?.guildId !== guildId ||
            current.channelInfo.channelId !== channelId || streaming.getSession(session.id) !== session) throw new WebAccessError(409, 'Streaming session changed; reconnect');
        if (!hasPermission(subject, 'join', session)) throw new WebAccessError(403, 'You need current join permission to operate your browser');
        return { session, stream: current, capabilities: { control: true, navigate: true } };
    };
    return Object.assign(authorize, { close() { closed = true; verify.close(); } });
}
