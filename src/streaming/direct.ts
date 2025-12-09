import { spawn, type ChildProcess } from "child_process";
import type { MediaUdp } from "@dank074/discord-video-stream";
import config from "../config.js";
import logger from "../utils/logger.js";

// Path to system FFmpeg
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

/**
 * DirectStreamService streams X11 capture directly to Discord
 * bypassing the library's internal FFmpeg re-encoding.
 * 
 * Version 3: Streaming NALs mode.
 * - Extracts NALs from FFmpeg Annex B stream.
 * - Converts to AVCC (length-prefixed).
 * - Sends VCL NALs (Slices/IDR) and headers (SPS/PPS) immediately.
 * - Manages RTP timestamps by detecting AUDs (Start of Frame).
 */
export class DirectStreamService {
    private ffmpegProcess: ChildProcess | null = null;
    private isStreaming = false;
    private frameBuffer: Buffer = Buffer.alloc(0);
    private frameCount = 0;
    
    // RTP Timestamp management
    private currentFrameTime = 0; 
    private frameDuration = 0;
    
    // Accumulate NAL units for the current Access Unit (Frame)
    private currentAccessUnit: Buffer[] = [];

    /**
     * Start streaming directly to Discord.
     * @param mediaUdp The MediaUdp connection from discord-video-stream
     */
    public async startStream(mediaUdp: MediaUdp): Promise<void> {
        if (this.isStreaming) {
            throw new Error("Stream already running");
        }

        const display = config.browser.display;
        const { width, height, fps, bitrateKbps, maxBitrateKbps, h26xPreset } = config.stream;
        
        // Duration of one frame in ms (e.g. 100ms for 10fps)
        // Library adds this to timestamp for each call.
        // We will pass 0 for NALs within the same frame, and 'frametime' when frame advances.
        this.frameDuration = Math.floor(1000 / fps);
        this.currentFrameTime = 0;

        // Set the packetizer to H264
        mediaUdp.setPacketizer("H264");

        logger.info(`Starting direct stream (v3) on ${display} at ${width}x${height}@${fps}fps`);

        // FFmpeg command to output raw H264 Annex B NAL units
        const args = [
            // Global options
            "-hide_banner",
            "-loglevel", "warning",
            
            // Ultra low latency input
            "-probesize", "32",
            "-analyzeduration", "0",
            "-fflags", "+nobuffer+genpts",
            "-flags", "+low_delay",
            
            // Video input: X11 display
            "-f", "x11grab",
            "-video_size", `${width}x${height}`,
            "-framerate", `${fps}`,
            "-draw_mouse", "0",
            "-i", `${display}+0,0`,
            
            // Audio input: PulseAudio
            "-f", "pulse",
            "-thread_queue_size", "1024",
            "-i", "default",
            
            // Video encoding - raw H264 Annex B output
            "-c:v", "libx264",
            "-preset", h26xPreset,
            "-tune", "zerolatency",
            "-profile:v", "baseline",
            "-level", "3.1",
            "-b:v", `${bitrateKbps}k`,
            "-maxrate", `${maxBitrateKbps}k`,
            "-bufsize", `${Math.floor(bitrateKbps / 2)}k`,
            "-pix_fmt", "yuv420p",
            "-g", `${fps}`, // Keyframe every second
            "-keyint_min", `${fps}`, // Minimum keyframe interval
            "-sc_threshold", "0", // No scene cut detection
            "-bf", "0", // No B-frames (low latency)
            "-refs", "1",
            "-threads", "1", // Single thread for simple NAL structure
            
            "-x264opts", "aud=1:no-mbtree:sync-lookahead=0:rc-lookahead=0", // aud=1 is CRITICAL for timestamping
            
            // Force 10fps output (prevent 1fps issue)
            "-r", `${fps}`,
            "-fps_mode", "cfr",
            
            // Output raw H264 Annex B (no container)
            "-f", "h264",
            "-bsf:v", "h264_mp4toannexb",
            "pipe:1",
            
            // Audio output (To NULL - we handle audio separately or not at all in this mode yet?)
            // Wait, DirectStream doesn't support audio piping yet unless we demux.
            // For now, let's just focus on VIDEO working. 
            // We'll generate silent audio frames manually to satisfy Discord.
            "-an" 
        ];

        logger.info(`FFmpeg direct stream: ${FFMPEG_PATH} ${args.slice(-10).join(" ")}`);

        this.ffmpegProcess = spawn(FFMPEG_PATH, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        this.isStreaming = true;
        this.frameCount = 0;
        this.frameBuffer = Buffer.alloc(0);

        // Process H264 NAL units from stdout
        this.ffmpegProcess.stdout?.on("data", async (data: Buffer) => {
            await this.processH264Data(data, mediaUdp);
        });

        this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
            const line = data.toString().trim();
            if (line && !line.startsWith("frame=") && !line.startsWith("size=")) {
                logger.debug(`FFmpeg: ${line}`);
            }
        });

        this.ffmpegProcess.on("error", (err) => {
            logger.error(`FFmpeg process error: ${err.message}`);
            this.stopStream();
        });

        this.ffmpegProcess.on("exit", (code) => {
            if (code !== 0 && this.isStreaming) {
                logger.error(`FFmpeg exited with code ${code}`);
            }
            this.isStreaming = false;
        });

        // Start silent audio stream (Discord requires audio)
        this.startSilentAudio(mediaUdp);
    }

    /**
     * Process incoming H264 data and extract NALs.
     * Sends NALs immediately.
     */
    private async processH264Data(data: Buffer, mediaUdp: MediaUdp): Promise<void> {
        // DEBUG: Log data reception
        if (this.frameCount === 0 && this.frameBuffer.length === 0) {
             logger.info(`Received first chunk of data: ${data.length} bytes. Header: ${data.subarray(0, 10).toString('hex')}`);
        }
        
        this.frameBuffer = Buffer.concat([this.frameBuffer, data]);

        while (true) {
            // Search for the 3-byte start code prefix (00 00 01)
            // 4-byte start codes (00 00 00 01) also contain this sequence at offset 1
            let startIndex = -1;
            let prefixLength = 0;
            
            // We need to iterate carefully to find the *first* start code
            // But Buffer.indexOf is efficient.
            const syncIndex = this.frameBuffer.indexOf(Buffer.from([0, 0, 1]));
            
            if (syncIndex === -1) break; // No start code found

            // Check if it's a 4-byte start code (preceded by 00)
            if (syncIndex > 0 && this.frameBuffer[syncIndex - 1] === 0) {
                startIndex = syncIndex - 1;
                prefixLength = 4;
            } else {
                startIndex = syncIndex;
                prefixLength = 3;
            }

            // If start code is not at the beginning, we have some "garbage" or previous NAL data
            // that was waiting for this start code to terminate it.
            if (startIndex > 0) {
                // discard initial garbage
                this.frameBuffer = this.frameBuffer.subarray(startIndex);
                continue; // Restart loop with aligned buffer
            }

            // Now buffer starts with a START CODE (offset 0).
            // We need to find the NEXT start code to know where this NAL ends.
            // We search starting from offset + prefixLength
            const nextSyncIndex = this.frameBuffer.indexOf(Buffer.from([0, 0, 1]), prefixLength);
            
            if (nextSyncIndex === -1) {
                // No next start code yet. Wait for more data.
                // Unless... buffer is getting huge?
                break;
            }

            // Determine if next is 3 or 4 bytes to calculate proper end index
            let nextStart = nextSyncIndex;
            if (nextSyncIndex > 0 && this.frameBuffer[nextSyncIndex - 1] === 0) {
                nextStart = nextSyncIndex - 1;
            }

            // NAL Data is between [prefixLength] and [nextStart]
            const nalUnit = this.frameBuffer.subarray(prefixLength, nextStart);
            await this.handleNalUnit(nalUnit, mediaUdp);

            // Shift buffer: remove the processed NAL AND its start code
            // The next iteration will find the next start code at 0
            this.frameBuffer = this.frameBuffer.subarray(nextStart);
        }
        // Safety: Prevent buffer from growing indefinitely
        if (this.frameBuffer.length > 5 * 1024 * 1024) {
            logger.warn("Frame buffer too large, resetting");
            this.frameBuffer = Buffer.alloc(0);
        }
    }

    /**
     * Handle a single extracted NAL unit.
     */
    // Track if the current access unit contains a VCL (Video Coding Layer) NAL (1-5)
    private hasVcl = false;

    private async handleNalUnit(nalData: Buffer, mediaUdp: MediaUdp): Promise<void> {
        const nalType = nalData[0] & 0x1F;

        // Log frame types for debugging
        if (nalType === 5 || this.frameCount < 5 || this.frameCount % 50 === 0) {
              const typeStr = nalType === 9 ? "AUD" : 
                             nalType === 5 ? "IDR" :
                             nalType === 1 ? "SLICE" :
                             nalType === 7 ? "SPS" :
                             nalType === 8 ? "PPS" : `${nalType}`;
              logger.info(`NAL Type: ${typeStr} (${nalData.length} bytes)`);
        }

        const isVcl = nalType >= 1 && nalType <= 5;

        // AUD (9) marks start of new frame.
        if (nalType === 9) {
            // Only flush if the *accumulated* unit has a VCL.
            // If strictly headers so far (or double AUD), keep accumulating.
            if (this.hasVcl) {
                await this.flushAccessUnit(mediaUdp);
                this.hasVcl = false;
            }
            
            // Start new access unit with this AUD
            this.currentAccessUnit.push(nalData);
            return;
        }

        if (isVcl) {
            this.hasVcl = true;
        }

        // Filter out SEI (6) - actually, allow it, might be needed for timing
        // if (nalType === 6) return;

        // Collect NAL (SPS, PPS, IDR, SLICE, SEI)
        this.currentAccessUnit.push(nalData);
    }

    /**
     * Send the accumulated Access Unit as a grouped AVCC frame.
     * The library's splitNalu expects [Length][Data] format!
     */
    private async flushAccessUnit(mediaUdp: MediaUdp): Promise<void> {
        if (this.currentAccessUnit.length === 0) return;

        // Calculate total size including length prefixes (4 bytes)
        let totalSize = 0;
        for (const nal of this.currentAccessUnit) {
            totalSize += 4 + nal.length;
        }

        const avccFrame = Buffer.allocUnsafe(totalSize);
        let offset = 0;

        for (const nal of this.currentAccessUnit) {
            // Write 4-byte Length per NAL
            avccFrame.writeUInt32BE(nal.length, offset); 
            offset += 4;
            nal.copy(avccFrame, offset);
            offset += nal.length;
        }

        try {
            await mediaUdp.sendVideoFrame(avccFrame, this.frameDuration);
            
            this.frameCount++;
            if (this.frameCount % 50 === 0) {
                logger.info(`Sent frame ${this.frameCount} size ${avccFrame.length}`);
            }
        } catch (error) {
            logger.debug(`Frame send error: ${error}`);
        }

        this.currentAccessUnit = [];
    }

    /**
     * Start sending silent audio frames.
     */
    private startSilentAudio(mediaUdp: MediaUdp): void {
        const silenceFrame = Buffer.from([0xF8, 0xFF, 0xFE]);
        const audioFrametime = 20; 

        const sendSilence = async () => {
            if (!this.isStreaming) return;
            try {
                // Audio needs its own monotonic clock, luckily 'sendAudioFrame' handles it via 'frametime'
                await mediaUdp.sendAudioFrame(silenceFrame, audioFrametime);
            } catch {}
            if (this.isStreaming) setTimeout(sendSilence, audioFrametime);
        };
        sendSilence();
    }

    /**
     * Stop the stream.
     */
    public stopStream(): void {
        if (!this.isStreaming) return;

        this.isStreaming = false;
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill("SIGTERM");
            this.ffmpegProcess = null;
        }
        this.frameBuffer = Buffer.alloc(0);
        logger.info(`Direct stream stopped.`);
    }

    public isRunning(): boolean {
        return this.isStreaming;
    }
}

// Singleton instance
let directStreamService: DirectStreamService | null = null;

export function getDirectStreamService(): DirectStreamService {
    if (!directStreamService) {
        directStreamService = new DirectStreamService();
    }
    return directStreamService;
}
