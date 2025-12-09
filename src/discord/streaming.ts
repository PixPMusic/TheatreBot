import { Client } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream, type MediaUdp } from "@dank074/discord-video-stream";
import type { Readable } from "stream";
import config from "../config.js";
import logger from "../utils/logger.js";
import type { StreamStatus, ChannelInfo, Session } from "../types/index.js";

/**
 * StreamingService manages Discord voice connections and video streaming.
 * Based on the StreamBot implementation pattern.
 */
export class StreamingService {
    private streamer: Streamer;
    private streamStatus: StreamStatus;
    private controller: AbortController | null = null;
    private sessions: Map<string, Session> = new Map();

    constructor(client: Client) {
        this.streamer = new Streamer(client);
        this.streamStatus = {
            joined: false,
            playing: false,
            manualStop: false,
            channelInfo: null,
        };
    }

    /**
     * Get the underlying Streamer instance.
     */
    public getStreamer(): Streamer {
        return this.streamer;
    }

    /**
     * Get current stream status.
     */
    public getStatus(): StreamStatus {
        return { ...this.streamStatus };
    }

    /**
     * Get a session by ID.
     */
    public getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get all active sessions.
     */
    public getAllSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Create a new streaming session for a voice channel.
     */
    public createSession(guildId: string, channelId: string, userId: string): Session {
        const sessionId = `${guildId}-${channelId}`;
        
        const session: Session = {
            id: sessionId,
            guildId,
            channelId,
            startedBy: userId,
            createdAt: new Date(),
            currentUrl: config.browser.defaultUrl,
        };

        this.sessions.set(sessionId, session);
        logger.info(`Created session ${sessionId} for user ${userId}`);
        
        return session;
    }

    /**
     * Join a Discord voice channel.
     */
    public async joinVoice(guildId: string, channelId: string): Promise<void> {
        if (this.streamStatus.joined && this.streamStatus.channelInfo?.channelId === channelId) {
            logger.info(`Already in voice channel ${channelId}`);
            return;
        }

        logger.info(`Joining voice channel ${channelId} in guild ${guildId}`);
        await this.streamer.joinVoice(guildId, channelId);
        
        this.streamStatus.joined = true;
        this.streamStatus.channelInfo = { guildId, channelId };
        
        // Wait for voice connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (!this.streamer.voiceConnection) {
            throw new Error("Failed to establish voice connection");
        }

        logger.info(`Successfully joined voice channel ${channelId}`);
    }

    /**
     * Leave the current voice channel.
     */
    public leaveVoice(): void {
        if (!this.streamStatus.joined) {
            return;
        }

        this.stopStream();
        this.streamer.leaveVoice();
        
        this.streamStatus.joined = false;
        this.streamStatus.channelInfo = null;
        
        logger.info("Left voice channel");
    }

    /**
     * Create the MediaUdp connection for direct streaming.
     * This is used for direct frame sending without library re-encoding.
     */
    public async createMediaUdp(): Promise<MediaUdp> {
        if (!this.streamStatus.joined) {
            throw new Error("Not connected to a voice channel");
        }

        const mediaUdp = await this.streamer.createStream();
        this.streamStatus.playing = true;
        
        return mediaUdp;
    }

    /**
     * Start streaming from an ffmpeg input source.
     * The input should be a file path, URL, or pipe that ffmpeg can read.
     */
    public async startStream(inputSource: string | Readable): Promise<void> {
        if (!this.streamStatus.joined) {
            throw new Error("Not connected to a voice channel");
        }

        if (this.streamStatus.playing) {
            logger.warn("Stream already playing, stopping first");
            this.stopStream();
        }

        this.streamStatus.playing = true;
        this.streamStatus.manualStop = false;
        this.controller = new AbortController();

        const streamOptions = {
            width: config.stream.width,
            height: config.stream.height,
            frameRate: config.stream.fps,
            bitrateVideo: config.stream.bitrateKbps,
            bitrateVideoMax: config.stream.maxBitrateKbps,
            videoCodec: Utils.normalizeVideoCodec(config.stream.videoCodec),
            hardwareAcceleratedDecoding: config.stream.hardwareAcceleration,
            minimizeLatency: true,
            h26xPreset: config.stream.h26xPreset,
            // Ultra low latency options
            rtcpSenderReportEnabled: true,
            readAtNativeFps: true,
            forceChacha20Encryption: false,
        };

        logger.info(`Starting stream with options: ${JSON.stringify(streamOptions)}`);

        try {
            const { command, output } = prepareStream(inputSource, streamOptions, this.controller.signal);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (command as any).on("error", (err: Error, _stdout: string, stderr: string) => {
                if (!this.streamStatus.manualStop && this.controller && !this.controller.signal.aborted) {
                    logger.error("FFmpeg error:", err.message);
                    if (stderr) {
                        logger.error("FFmpeg stderr:", stderr);
                    }
                    this.controller.abort();
                }
            });

            await playStream(output, this.streamer, undefined, this.controller.signal);

            if (!this.streamStatus.manualStop) {
                logger.info("Stream ended naturally");
            }
        } catch (error) {
            if (!this.streamStatus.manualStop) {
                logger.error("Stream error:", error);
            }
        } finally {
            this.streamStatus.playing = false;
        }
    }

    /**
     * Stop the current stream.
     */
    public stopStream(): void {
        if (!this.streamStatus.playing) {
            return;
        }

        this.streamStatus.manualStop = true;
        this.controller?.abort();
        this.streamer.stopStream();
        this.streamStatus.playing = false;

        logger.info("Stream stopped");
    }

    /**
     * Clean up all resources.
     */
    public cleanup(): void {
        this.stopStream();
        this.leaveVoice();
        this.sessions.clear();
    }
}

let streamingService: StreamingService | null = null;

/**
 * Initialize the streaming service with a Discord client.
 */
export function initStreamingService(client: Client): StreamingService {
    if (streamingService) {
        return streamingService;
    }
    
    streamingService = new StreamingService(client);
    return streamingService;
}

/**
 * Get the current streaming service instance.
 */
export function getStreamingService(): StreamingService | null {
    return streamingService;
}
