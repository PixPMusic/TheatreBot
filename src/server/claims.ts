import { randomBytes } from 'node:crypto';
import { getStreamingService, type StartupReservation } from '../discord/streaming.js';
import { getBrowserControls } from '../browser/controls.js';
import { getCaptureService } from '../browser/capture.js';
import { getDirectStreamService } from '../streaming/direct.js';
import { hasPermission, type PermissionSubject } from '../rbac/permissions.js';
import { createMemberVerification, WebAccessError } from './authorization.js';
import type { WebSession } from './oauth.js';
import type { Session } from '../types/index.js';
import logger from '../utils/logger.js';

export interface Claim {
    readonly id: string; readonly guildId: string; readonly channelId: string; readonly ownerId: string;
    readonly mode: 'direct' | 'stable'; readonly expiresAt: number; readonly reservation: StartupReservation;
    phase: 'pending' | 'starting' | 'active' | 'stopping';
}
export interface ClaimDependencies {
    reserve(guild: string, channel: string, user: string): StartupReservation | null;
    verify(user: string, guild: string, channel: string, valid?: () => boolean): Promise<PermissionSubject>;
    start(claim: Claim, current: () => boolean, ended: (cause?: unknown) => void): Promise<void>;
    stop(): Promise<void>;
    now?: () => number;
    lifetimeMs?: number;
}

/** One pending claim and one generation across browser, voice and both capture modes. */
export class StreamClaims {
    private current: Claim | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopping: Promise<void> | undefined;
    private readonly now: () => number;
    constructor(private readonly deps: ClaimDependencies) { this.now = deps.now ?? Date.now; }
    request(guildId: string, channelId: string, ownerId: string, mode: Claim['mode']): Claim {
        if (this.current) {
            if (this.current.phase === 'pending' && this.current.expiresAt > this.now() &&
                this.current.guildId === guildId && this.current.channelId === channelId && this.current.ownerId === ownerId && this.current.mode === mode) return this.current;
            throw new WebAccessError(409, 'Already streaming, awaiting a claim, or stopping. Use !leave first.');
        }
        const reservation = this.deps.reserve(guildId, channelId, ownerId);
        if (!reservation) throw new WebAccessError(409, 'Already streaming or starting. Use !leave first.');
        const claim: Claim = { id: randomBytes(32).toString('hex'), guildId, channelId, ownerId, mode,
            expiresAt: this.now() + (this.deps.lifetimeMs ?? 5 * 60_000), reservation, phase: 'pending' };
        this.current = claim;
        this.timer = setTimeout(() => { if (this.current === claim && claim.phase === 'pending') void this.stop().catch(error => logger.error('Claim expiration cleanup failed:', error)); }, this.deps.lifetimeMs ?? 5 * 60_000);
        this.timer.unref();
        return claim;
    }
    pending(): Claim | undefined { return this.current?.phase === 'pending' ? this.current : undefined; }
    private check(id: string, login: WebSession, valid: () => boolean): Claim {
        if (!valid()) throw new WebAccessError(401, 'Sign in with Discord again');
        const claim = this.current;
        if (!claim || claim.id !== id || claim.phase !== 'pending' || claim.expiresAt <= this.now()) throw new WebAccessError(409, 'Claim expired, cancelled, or already used. Request !join again.');
        if (claim.ownerId !== login.user.id) throw new WebAccessError(403, 'Only the Discord user who requested this stream can claim it');
        return claim;
    }
    async claim(id: string, login: WebSession, valid: () => boolean): Promise<void> {
        const claim = this.check(id, login, valid);
        const subject = await this.deps.verify(login.user.id, claim.guildId, claim.channelId, valid);
        if (this.check(id, login, valid) !== claim) throw new WebAccessError(409, 'Claim changed; request !join again');
        if (subject.id !== claim.ownerId || subject.guild.id !== claim.guildId || subject.voice.channelId !== claim.channelId || !hasPermission(subject, 'join')) throw new WebAccessError(403, 'You need current join permission to start this stream');
        // No await between final verification and ownership transition: concurrent POSTs cannot start twice.
        claim.phase = 'starting';
        if (this.timer) clearTimeout(this.timer);
        const current = () => this.current === claim && claim.phase !== 'stopping' && (claim.phase === 'active' || valid());
        try {
            await this.deps.start(claim, current, cause => {
                if (!current()) return;
                if (cause) logger.error('Owned stream ended with an error:', cause);
                void this.stop().catch(error => logger.error('Stream cleanup failed:', error));
            });
            if (!current()) throw new WebAccessError(409, 'Stream startup was cancelled');
            claim.phase = 'active';
        } catch (error) {
            if (this.current === claim && (claim.phase as Claim["phase"]) !== "stopping") await this.stop();
            throw error;
        }
    }
    /** Invalidate first; retain reservation/authorization metadata until every resource exits. */
    stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        const claim = this.current;
        if (claim) claim.phase = 'stopping';
        if (this.timer) clearTimeout(this.timer);
        this.stopping = Promise.resolve().then(() => this.deps.stop()).then(() => {
            if (this.current === claim) this.current = undefined;
        }).finally(() => { this.stopping = undefined; });
        return this.stopping;
    }
    departing(user: string, guild: string, channel: string): Promise<void> | undefined {
        const claim = this.current;
        if (claim && claim.ownerId === user && claim.guildId === guild && claim.channelId === channel) return this.stop();
    }
}

let verify = createMemberVerification();
export function resetClaimVerification(): void { verify.close(); verify = createMemberVerification(); }
export const streamClaims = new StreamClaims({
    reserve: (guild, channel, user) => getStreamingService()?.reserveStartup(guild, channel, user) ?? null,
    verify: (user, guild, channel, valid) => verify(user, guild, channel, { fresh: true, valid }),
    async start(claim, current, ended) {
        const streaming = getStreamingService();
        if (!streaming) throw new Error('Streaming service unavailable');
        const assertCurrent = () => { if (!current() || !streaming.isStartupCurrent(claim.reservation)) throw new WebAccessError(409, 'Stream startup cancelled'); };
        await getBrowserControls().initialize(claim.ownerId);
        assertCurrent();
        const subject = await verify(claim.ownerId, claim.guildId, claim.channelId, { fresh: true, valid: current });
        assertCurrent();
        if (!hasPermission(subject, 'join')) throw new WebAccessError(403, 'Join permission was revoked during browser startup');
        await streaming.joinVoice(claim.guildId, claim.channelId, claim.reservation);
        assertCurrent();
        const afterJoin = await verify(claim.ownerId, claim.guildId, claim.channelId, { fresh: true, valid: current });
        assertCurrent();
        if (!hasPermission(afterJoin, 'join')) throw new WebAccessError(403, 'Join permission was revoked during voice startup');
        streaming.createSession(claim.guildId, claim.channelId, claim.ownerId);
        const playback = claim.mode === 'stable'
            ? streaming.startStream(getCaptureService().startCapture(), () => getCaptureService().stopCapture())
            : getDirectStreamService().startStream(streaming);
        playback.then(() => ended(), ended);
        streaming.completeStartup(claim.reservation);
    },
    async stop() {
        const streaming = getStreamingService();
        streaming?.beginTeardown();
        // Every producer must settle before the display/profile can be reused.
        await Promise.all([getDirectStreamService().stopAndWait(), getCaptureService().stopAndWait()]);
        await getBrowserControls().close();
        streaming?.leaveVoice();
    },
});
