import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import type { StreamingService } from "../discord/streaming.js";
import { stopAndWait } from "../browser/child-exit.js";
import config from "../config.js";
import logger from "../utils/logger.js";

const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

/** Single H264 encode plus real PulseAudio, demuxed and transported by v7. */
export function directStreamArguments(): string[] {
    const { width, height, fps, bitrateKbps, maxBitrateKbps, h26xPreset } = config.stream;
    return [
        "-hide_banner", "-loglevel", "warning",
        // Bound startup analysis and minimize buffering on the live video input.
        "-probesize", "32", "-analyzeduration", "0", "-fflags", "nobuffer",
        "-f", "x11grab", "-video_size", `${width}x${height}`,
        "-framerate", `${fps}`, "-draw_mouse", "0",
        "-i", `${config.browser.display}+0,0`,
        "-f", "pulse", "-i", "default",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", h26xPreset, "-tune", "zerolatency",
        "-b:v", `${bitrateKbps}k`, "-maxrate", `${maxBitrateKbps}k`,
        "-bufsize", `${Math.floor(bitrateKbps / 2)}k`, "-pix_fmt", "yuv420p",
        "-g", `${fps}`, "-keyint_min", `${fps}`, "-sc_threshold", "0", "-bf", "0",
        "-r", `${fps}`, "-fps_mode", "cfr",
        "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-frame_duration", "20", "-application", "lowdelay",
        // v7's native H264 bitstream filters expect the Annex B form carried by NUT.
        "-f", "nut",
        "-flush_packets", "1", "pipe:1",
    ];
}

export class DirectStreamService {
    private ffmpegProcess: ChildProcess | null = null;
    private stopPlayback: (() => void) | null = null;

    /** Allow a supplied process launcher for deterministic capture lifecycle tests. */
    constructor(private readonly spawnProcess: typeof spawn = spawn) {}

    /** Resolves at EOF/stop; rejects on capture or playback failure. */
    public async startStream(streamingService: StreamingService): Promise<void> {
        if (this.ffmpegProcess) throw new Error("Stream already running");
        const process = this.spawnProcess(FFMPEG_PATH, directStreamArguments(), {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.ffmpegProcess = process;
        this.stopPlayback = () => streamingService.stopStream();
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
            if (this.ffmpegProcess === process) {
                this.stopPlayback = null;
            }
        };
        const completion = new Promise<void>((resolve, reject) => {
            process.once("error", reject);
            process.once("close", (code, signal) => {
                if (this.ffmpegProcess === process) this.ffmpegProcess = null;
                if (stopped || code === 0) resolve();
                else reject(new Error(`FFmpeg capture exited with ${signal ?? code}`));
            });
        });
        // Attach immediately, including when the voice service refuses the source.
        completion.catch(() => {});
        process.stderr?.on("data", (data: Buffer) => logger.debug(`FFmpeg: ${data.toString().trim()}`));
        logger.info("Starting direct H264/Opus NUT capture");
        try {
            await streamingService.startEncodedStream(process.stdout as Readable, completion, stop);
        } finally {
            stop();
        }
    }

    /** Abort the playback run, which also terminates its owned capture process. */
    public async stopAndWait(): Promise<void> {
        const process = this.ffmpegProcess;
        this.stopStream();
        await stopAndWait(process);
        if (this.ffmpegProcess === process) this.ffmpegProcess = null;
    }

    public stopStream(): void {
        this.stopPlayback?.();
    }

    /** Report whether this service currently owns a capture process. */
    public isRunning(): boolean {
        return this.ffmpegProcess !== null;
    }
}

let directStreamService: DirectStreamService | null = null;
/** Return the shared direct capture service used by Discord commands. */
export function getDirectStreamService(): DirectStreamService {
    return directStreamService ??= new DirectStreamService();
}
