import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, Utils, Encoders, prepareStream, playStream, type PrepareStreamOptions, type PlayStreamOptions } from "@dank074/discord-video-stream";
import type { Readable } from "stream";
import config from "../config.js";
import logger from "../utils/logger.js";
import type { StreamStatus, Session } from "../types/index.js";

export interface StreamingDependencies {
    streamer: Streamer;
    prepareStream: typeof prepareStream;
    playStream: typeof playStream;
}

interface StreamRun {
    controller: AbortController;
    manualStop: boolean;
}

/** Map configured quality and latency settings onto the v7 encoder API. */
export function stableStreamOptions(): Partial<PrepareStreamOptions> {
    return {
        width: config.stream.width,
        height: config.stream.height,
        frameRate: config.stream.fps,
        bitrateVideo: config.stream.bitrateKbps,
        bitrateVideoMax: config.stream.maxBitrateKbps,
        videoCodec: Utils.normalizeVideoCodec(config.stream.videoCodec),
        hardwareAcceleratedDecoding: config.stream.hardwareAcceleration,
        // v7 emits the invalid FFmpeg flag "lowdelay"; preserve latency tuning with "low_delay".
        minimizeLatency: false,
        customInputOptions: ["-fflags nobuffer", "-flags low_delay", "-flush_packets 1", "-max_delay 100000"],
        encoder: Encoders.software({
            x264: { preset: config.stream.h26xPreset, tune: "zerolatency" },
            x265: { preset: config.stream.h26xPreset, tune: "zerolatency" },
        }),
    };
}

/**
 * StreamingService manages Discord voice connections and video streaming.
 * Based on the StreamBot implementation pattern.
 */
export class StreamingService {
    private streamer: Streamer;
    private streamStatus: StreamStatus;
    private activeStream: StreamRun | null = null;
    private readonly media: Pick<StreamingDependencies, "prepareStream" | "playStream">;
    private sessions: Map<string, Session> = new Map();

    /** Create the voice service with production media APIs or supplied test dependencies. */
    constructor(client: Client, dependencies: Partial<StreamingDependencies> = {}) {
        this.streamer = dependencies.streamer ?? new Streamer(client);
        this.media = {
            prepareStream: dependencies.prepareStream ?? prepareStream,
            playStream: dependencies.playStream ?? playStream,
        };
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

    /** Transcode the stable MPEG-2/PCM capture to v7's NUT output. */
    public async startStream(inputSource: string | Readable, stopCapture: () => void = () => {}): Promise<void> {
        await this.runStream((signal, inputError) => {
            if (typeof inputSource !== "string") {
                inputSource.on("error", inputError);
            }
            const { output, promise } = this.media.prepareStream(inputSource, stableStreamOptions(), signal);
            return { output, completion: promise };
        }, "nut", stopCapture);
    }

    /** Play pre-encoded H264/Opus capture without another video encode. */
    public async startEncodedStream(output: Readable, completion: Promise<unknown>, stopCapture: () => void): Promise<void> {
        await this.runStream(() => ({ output, completion }), "nut", stopCapture);
    }

    /** Own producer/playback cancellation and prevent late cleanup from affecting a replacement. */
    private async runStream(
        prepare: (signal: AbortSignal, inputError: (error: Error) => void) => { output: Readable; completion: Promise<unknown> },
        format: PlayStreamOptions["format"],
        stopCapture: () => void,
    ): Promise<void> {
        if (!this.streamStatus.joined) {
            stopCapture();
            throw new Error("Not connected to a voice channel");
        }
        this.stopStream();
        const run: StreamRun = { controller: new AbortController(), manualStop: false };
        const { signal } = run.controller;
        this.activeStream = run;
        this.streamStatus.playing = true;
        this.streamStatus.manualStop = false;

        let output: Readable | undefined;
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            output?.destroy();
            stopCapture();
            if (this.activeStream === run) this.streamer.stopStream();
        };
        const aborted = new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => {
                cleanup();
                reject(signal.reason);
            }, { once: true });
        });
        // Observe abort even if prepareStream throws synchronously.
        aborted.catch(() => {});
        const fail = (error: unknown): never => {
            run.controller.abort(error);
            throw error;
        };
        const inputError = (error: Error) => run.controller.abort(error);
        try {
            const prepared = prepare(signal, inputError);
            output = prepared.output;
            output.on("error", inputError);
            const producer = prepared.completion.catch(fail);
            producer.catch(() => {});
            // v7 can wait in demux/createStream before attaching its abort handler.
            // Guard creation and cleanup so a stopped run cannot start/stop a later run.
            const guardedStreamer = new Proxy(this.streamer, {
                get: (target, property) => {
                    if (property === "createStream") return async () => {
                        signal.throwIfAborted();
                        const creation = target.createStream().then(conn => {
                            if (signal.aborted) {
                                conn.close();
                                signal.throwIfAborted();
                            }
                            return conn;
                        });
                        return await Promise.race([creation, aborted]);
                    };
                    if (property === "stopStream") return () => {
                        if (this.activeStream === run) target.stopStream();
                    };
                    const value = Reflect.get(target, property, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const playback = this.media.playStream(output, guardedStreamer, {
                type: "go-live", format, streamPreview: false,
            }, signal).catch(fail);
            await Promise.race([Promise.all([playback, producer]), aborted]);
            logger.info("Stream ended naturally");
        } catch (error) {
            if (!run.manualStop) {
                logger.error("Stream error:", error);
                throw error;
            }
        } finally {
            cleanup();
            run.controller.abort();
            // Keep the error observer attached to a destroyed source until any late error arrives.
            if (this.activeStream === run) {
                this.activeStream = null;
                this.streamStatus.playing = false;
            }
        }
    }

    /** Stop the producer and playback belonging to the current run. */
    public stopStream(): void {
        const run = this.activeStream;
        if (!run) return;
        run.manualStop = true;
        this.streamStatus.manualStop = true;
        run.controller.abort();
        this.activeStream = null;
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
