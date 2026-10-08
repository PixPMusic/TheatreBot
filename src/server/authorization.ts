import { getClient } from "../discord/client.js";
import { getStreamingService } from "../discord/streaming.js";
import { canControlSession, canNavigate, type PermissionSubject } from "../rbac/permissions.js";
import type { Session, StreamStatus } from "../types/index.js";
import type { OAuthService, WebSession } from "./oauth.js";

export class WebAccessError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export interface AuthorizedView {
    session: Session;
    stream: StreamStatus;
    capabilities: { control: boolean; navigate: boolean };
}

/** Derive the subject from OAuth membership plus trusted gateway guild/voice state. */
export function createAuthorization(oauth: OAuthService): (login: WebSession) => Promise<AuthorizedView> {
    return async login => {
        if (!oauth.valid(login)) throw new WebAccessError(401, "Sign in with Discord again");
        const streaming = getStreamingService();
        const client = getClient();
        const stream = streaming?.getStatus();
        if (!streaming || !client || !stream?.joined || !stream.channelInfo) {
            throw new WebAccessError(409, "Start a stream with !join and join its voice channel first");
        }
        const { guildId, channelId } = stream.channelInfo;
        const active = streaming.getSession(`${guildId}-${channelId}`);
        const guild = client.guilds.cache.get(guildId);
        if (!active || !guild) throw new WebAccessError(403, "No accessible streaming session");
        let membership;
        try { membership = await oauth.membership(login, guildId); }
        catch { throw new WebAccessError(403, "Discord could not verify membership in this session's server"); }

        // Re-read the live session and voice state after the network await.
        const current = streaming.getStatus();
        if (!oauth.valid(login) || !current.joined || current.channelInfo?.guildId !== guildId ||
            current.channelInfo.channelId !== channelId || streaming.getSession(active.id) !== active) {
            throw new WebAccessError(409, "The streaming session changed; reconnect");
        }
        const roles = new Set([guildId, ...membership.roles]);
        const subject: PermissionSubject = {
            id: login.user.id,
            guild: { id: guildId, ownerId: guild.ownerId },
            voice: { channelId: guild.voiceStates.cache.get(login.user.id)?.channelId ?? null },
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
}
