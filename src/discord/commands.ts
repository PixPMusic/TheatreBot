import type { Message, VoiceState, VoiceChannel, StageChannel } from "@lng2004/discord.js-selfbot-v13";
import { getClient } from "./client.js";
import { getStreamingService } from "./streaming.js";
import { getBrowserControls } from "../browser/controls.js";
import { getDirectStreamService } from "../streaming/direct.js";
import logger from "../utils/logger.js";

const COMMAND_PREFIX = "!";

/**
 * Setup message command handlers.
 */
export function setupCommands(): void {
    const client = getClient();
    if (!client) {
        logger.error("Cannot setup commands: client not initialized");
        return;
    }

    // Handle message commands from any user
    client.on("messageCreate", async (message: Message) => {
        // Ignore bot messages and DMs
        if (message.author.bot) return;
        if (!message.guild) return;
        
        // Check for command prefix
        if (!message.content.startsWith(COMMAND_PREFIX)) return;

        const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
        const command = args.shift()?.toLowerCase();

        try {
            switch (command) {
                case "join":
                case "beta":
                    await handleJoin(message);
                    break;
                case "stable":
                    await handleStable(message);
                    break;
                case "leave":
                    await handleLeave(message);
                    break;
                case "url":
                case "goto":
                    await handleUrl(message, args);
                    break;
                case "help":
                    await handleHelp(message);
                    break;
                default:
                    // Not a recognized command, ignore
                    return;
            }
            
            // Add green checkmark reaction to acknowledge command
            await message.react("✅");
            
        } catch (error) {
            logger.error(`Command error (${command}):`, error);
            // Add error reaction
            await message.react("❌").catch(() => {});
        }
    });

    // Handle voice state updates for auto-leave
    client.on("voiceStateUpdate", async (oldState: VoiceState, newState: VoiceState) => {
        await handleVoiceStateUpdate(oldState, newState);
    });

    logger.info("Discord commands initialized");
    logger.info("Commands: !join, !beta (alias), !stable, !leave, !url <url>, !help");
}

import { getCaptureService } from "../browser/capture.js";

// ... existing imports

/**
 * Handle !stable command using the older MPEG-2/PCM capture and transcoding path.
 */
async function handleStable(message: Message): Promise<void> {
    const client = getClient();
    const streamingService = getStreamingService();
    
    if (!client || !streamingService) {
        throw new Error("Bot not fully initialized");
    }

    // Get the sender's guild member
    const member = message.member;
    if (!member) {
        throw new Error("Could not find member in guild");
    }

    // Check if sender is in a voice channel
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
        await message.reply("❌ You must be in a voice channel first");
        return;
    }

    const channelName = 'name' in voiceChannel ? voiceChannel.name : 'voice channel';
    
    // Check if already streaming
    const status = streamingService.getStatus();
    if (status.joined) {
        await message.reply(`❌ Already streaming in another channel. Use !leave first.`);
        return;
    }

    logger.info(`Stable stream requested by ${message.author.tag} for channel ${channelName}`);

    // Create session and join
    const session = streamingService.createSession(
        message.guild!.id,
        voiceChannel.id,
        message.author.id
    );

    // Initialize browser
    const controls = getBrowserControls();
    await controls.initialize();

    await streamingService.joinVoice(message.guild!.id, voiceChannel.id);

    // Start CaptureService (Stable)
    const captureService = getCaptureService();
    const stream = captureService.startCapture();

    // Pipe to Discord - Do NOT await this as it blocks until stream ends
    streamingService.startStream(stream, () => captureService.stopCapture()).catch(e => {
        logger.error("Stable stream error:", e);
        // Only try to reply if message is recent enough, otherwise just log
        message.channel.send(`❌ Stream error: ${e.message}`).catch(() => {});
    });

    await message.reply(`📺 Now streaming in **${channelName}** (Stable/Slow Mode)`);
    logger.info(`Started stable stream in ${channelName}`);
}

/**
 * Handle !join and its !beta alias with direct H264/Opus capture over v7 WebRTC/DAVE.
 */
async function handleJoin(message: Message): Promise<void> {
    const client = getClient();
    const streamingService = getStreamingService();
    
    if (!client || !streamingService) return;

    const member = message.member;
    if (!member?.voice.channel) {
        await message.reply("❌ You must be in a voice channel first");
        return;
    }

    const voiceChannel = member.voice.channel;
    const channelName = 'name' in voiceChannel ? voiceChannel.name : 'voice channel';

    // Check if already streaming
    const status = streamingService.getStatus();
    if (status.joined) {
        await message.reply(`❌ Already streaming. Use !leave first.`);
        return;
    }

    // Prepare the browser before joining so a startup failure leaves the command retryable.
    const controls = getBrowserControls();
    await controls.initialize();

    await streamingService.joinVoice(message.guild!.id, voiceChannel.id);

    // Create session
    streamingService.createSession(message.guild!.id, voiceChannel.id, message.author.id);

    // Playback runs until EOF/stop, so observe failures without blocking !leave.
    const directStream = getDirectStreamService();
    directStream.startStream(streamingService).catch(error => {
        logger.error("Direct stream error:", error);
        message.channel.send(`❌ Stream error: ${error.message}`).catch(() => {});
    });

    await message.reply(`📺 Now streaming in **${channelName}** (H264 + browser audio)`);
    logger.info(`Started direct stream in ${channelName}`);
}

/**
 * Handle !leave command - leaves the current voice channel.
 */
async function handleLeave(message: Message): Promise<void> {
    const streamingService = getStreamingService();
    
    if (!streamingService) {
        throw new Error("Streaming service not initialized");
    }

    const status = streamingService.getStatus();
    if (!status.joined) {
        await message.reply("❌ Not currently in a voice channel");
        return;
    }

    logger.info(`Leave requested by ${message.author.tag}`);

    // Stop direct capture (the default mode)
    const directStream = getDirectStreamService();
    directStream.stopStream();

    // Stop Capture Stream (if stable)
    // This is handled by streamingService.leaveVoice() -> stopStream()
    // But we also need to stop the ffmpeg capture process itself
    const captureService = getCaptureService();
    captureService.stopCapture();

    // Leave voice
    streamingService.leaveVoice();

    await message.reply("👋 Left the voice channel");
    logger.info("Left voice channel via command");
}

/**
 * Handle !url command - navigate to a URL.
 */
async function handleUrl(message: Message, args: string[]): Promise<void> {
    const url = args.join(" ");
    if (!url) {
        await message.reply("❌ Usage: `!url <url>`");
        return;
    }

    const streamingService = getStreamingService();
    const status = streamingService?.getStatus();
    
    if (!status?.joined) {
        await message.reply("❌ Bot must be streaming first. Use `!join`");
        return;
    }

    const controls = getBrowserControls();
    await controls.navigateTo(url);
    
    await message.reply(`🔗 Navigated to: ${url}`);
    logger.info(`URL changed to ${url} by ${message.author.tag}`);
}

/**
 * Handle !help command.
 */
async function handleHelp(message: Message): Promise<void> {
    await message.reply(`
**Theatre Bot Commands**
\`!join\` - Join and stream with a single H264 encode and browser audio (default)
\`!beta\` - Alias for \`!join\`
\`!stable\` - Join using the older MPEG-2/PCM capture and transcoding path
\`!leave\` - Leave the voice channel
\`!url <url>\` - Navigate to a URL
\`!help\` - Show this help
    `.trim());
}

/**
 * Handle voice state updates - auto-leave when channel is empty.
 */
async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const client = getClient();
    const streamingService = getStreamingService();
    
    if (!client || !streamingService) return;

    const status = streamingService.getStatus();
    if (!status.joined || !status.channelInfo) return;

    // Check if someone left our channel
    if (oldState.channelId !== status.channelInfo.channelId) return;
    if (newState.channelId === status.channelInfo.channelId) return;

    // Get the channel
    const channel = client.channels.cache.get(status.channelInfo.channelId) as VoiceChannel | StageChannel | undefined;
    if (!channel) return;

    // Count members (excluding the bot itself)
    const memberCount = channel.members.filter(m => m.id !== client.user?.id).size;

    if (memberCount === 0) {
        logger.info("All users left the voice channel, auto-leaving...");

        // Stop direct stream
        const directStream = getDirectStreamService();
        directStream.stopStream();
        
        // Stop capture stream
        const captureService = getCaptureService();
        captureService.stopCapture();

        // Leave voice
        streamingService.leaveVoice();

        logger.info("Auto-left voice channel (empty)");
    }
}
