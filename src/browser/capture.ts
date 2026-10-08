import { spawn, type ChildProcess } from "child_process";
import { Readable } from "stream";
import { stopAndWait } from "./child-exit.js";
import config from "../config.js";
import logger from "../utils/logger.js";

// Path to system FFmpeg
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

/**
 * CaptureService handles screen capture via system FFmpeg.
 * Uses x11grab for video on Linux/Xvfb.
 * Outputs directly to stdout for piping to discord-video-stream.
 */
export class CaptureService {
    private ffmpegProcess: ChildProcess | null = null;
    private isCapturing = false;
    private outputStream: Readable | null = null;

    /**
     * Check if capture is currently running.
     */
    public isRunning(): boolean {
        return this.isCapturing;
    }

    /**
     * Start capturing the X11 display.
     * Returns a Readable stream that can be passed directly to discord-video-stream.
     */
    public startCapture(): Readable {
        if (this.ffmpegProcess && !this.isCapturing) throw new Error("Capture process is still stopping");
        if (this.isCapturing && this.outputStream) {
            return this.outputStream;
        }

        const display = config.browser.display;
        const { width, height, fps } = config.stream;

        logger.info(`Starting X11 capture on ${display} at ${width}x${height}@${fps}fps`);

        // Build FFmpeg command - output to stdout as matroska (lower latency than mpegts)
        const args = [
            // Global options
            "-hide_banner",
            "-loglevel", "warning",
            
            // Ultra low latency input
            "-probesize", "32",
            "-analyzeduration", "0",
            "-fflags", "+nobuffer+flush_packets+genpts",
            "-flags", "+low_delay",
            "-rtbufsize", "64M",
            
            // Video input: X11 display
            "-f", "x11grab",
            "-video_size", `${width}x${height}`,
            "-framerate", `${fps}`,
            "-draw_mouse", "0",
            "-i", `${display}+0,0`,
            
            // Audio input: PulseAudio
            "-f", "pulse",
            "-i", "default",
            
            // Video encoding - MPEG-2 (Lightweight Intermediate)
            // Much faster than H.264, much smaller than Raw
            "-c:v", "mpeg2video",
            "-b:v", "5000k",        // High bitrate to maintain quality before final encode
            "-maxrate", "5000k",
            "-bufsize", "2500k",
            "-pix_fmt", "yuv420p",
            "-g", `${fps}`,         // GOP size
            "-threads", "4",
            
            // Force constant frame rate
            "-r", `${fps}`,
            "-fps_mode", "cfr",
            
            // Audio encoding - PCM (Raw, no CPU usage)
            "-c:a", "pcm_s16le",
            "-ar", "48000",
            "-ac", "2",
            
            // Output container: Matroska
            "-f", "matroska",
            "-cluster_size_limit", "1K",
            "-cluster_time_limit", "20",
            "-flush_packets", "1",
            "pipe:1",
        ];

        logger.info(`FFmpeg capture command: ${FFMPEG_PATH} ${args.join(" ")}`);

        // Spawn FFmpeg process
        const process = spawn(FFMPEG_PATH, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        this.ffmpegProcess = process;
        this.isCapturing = true;
        const output = process.stdout as Readable;
        this.outputStream = output;

        process.stderr?.on("data", (data: Buffer) => {
            const line = data.toString().trim();
            if (line && !line.startsWith("frame=") && !line.startsWith("size=")) {
                logger.debug(`FFmpeg: ${line}`);
            }
        });

        process.on("error", (err) => {
            logger.error(`FFmpeg process error: ${err.message}`);
            output.destroy(err);
            if (this.ffmpegProcess === process) this.stopCapture();
        });

        process.on("close", (code) => {
            if (this.ffmpegProcess !== process) return;
            if (code !== 0 && this.isCapturing) {
                output.destroy(new Error(`FFmpeg capture exited with code ${code}`));
            }
            this.ffmpegProcess = null;
            this.isCapturing = false;
            this.outputStream = null;
        });

        return output;
    }

    /**
     * Stop the capture.
     */
    public async stopAndWait(): Promise<void> {
        const process = this.ffmpegProcess;
        this.stopCapture();
        await stopAndWait(process);
        if (this.ffmpegProcess === process) this.ffmpegProcess = null;
    }

    public stopCapture(): void {
        if (!this.isCapturing) {
            return;
        }

        this.isCapturing = false;

        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill("SIGTERM");
        }
        
        this.outputStream?.destroy();
        this.outputStream = null;
        logger.info("Capture stopped");
    }
}

// Singleton instance
let captureService: CaptureService | null = null;

export function getCaptureService(): CaptureService {
    if (!captureService) {
        captureService = new CaptureService();
    }
    return captureService;
}
