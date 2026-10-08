import type { Message, VoiceState, VoiceChannel, StageChannel, GuildMember } from "@lng2004/discord.js-selfbot-v13";
import { getClient } from "./client.js";
import { getStreamingService } from "./streaming.js";
import { getBrowserControls } from "../browser/controls.js";
import logger from "../utils/logger.js";
import { hasPermission, canControlSession } from "../rbac/permissions.js";
import config from "../config.js";
import { streamClaims } from "../server/claims.js";
import { WebAccessError, createMemberVerification } from "../server/authorization.js";
import { validateServerConfiguration } from "../server/index.js";
import type { Session } from "../types/index.js";

const COMMAND_PREFIX = "!";
const verifyBrowserOwner = createMemberVerification();

class PermissionDeniedError extends Error {}

function requireMember(message: Message): GuildMember {
    const member = message.member;
    if (!message.guild || !member || member.id !== message.author.id || member.guild.id !== message.guild.id) {
        throw new PermissionDeniedError("Your membership in this server could not be verified.");
    }
    return member;
}

function requireJoinChannel(message: Message) {
    const member = requireMember(message);
    const channel = member.voice.channel;
    if (!channel || !("guild" in channel) || member.voice.channelId !== channel.id || channel.guild.id !== message.guild!.id) {
        throw new PermissionDeniedError("You must be in a voice channel in this server first.");
    }
    if (!hasPermission(member, "join")) {
        throw new PermissionDeniedError("You need join permission to start a stream.");
    }
    return channel;
}

function requireActiveSession(message: Message, allowPending = false): { member: GuildMember; session: Session } {
    const member = requireMember(message);
    const service = getStreamingService();
    const status = service?.getStatus();
    // Pending metadata also survives a failed teardown so an authorized caller can retry !leave.
    const pending = !status?.joined && allowPending ? service?.getPendingSession() : undefined;
    const channel = status?.joined ? status.channelInfo : pending;
    const session = pending ?? (channel ? service?.getSession(`${channel.guildId}-${channel.channelId}`) : undefined);
    if (!channel || !session || session.guildId !== channel.guildId
        || session.channelId !== channel.channelId || session.id !== `${channel.guildId}-${channel.channelId}`) {
        throw new PermissionDeniedError("No active streaming session is available.");
    }
    if (member.guild.id !== channel.guildId || member.voice.channelId !== channel.channelId) {
        throw new PermissionDeniedError("You must be in the active stream's voice channel in this server.");
    }
    return { member, session };
}

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
            if (error instanceof PermissionDeniedError || error instanceof WebAccessError) {
                await message.reply(`❌ ${error.message}`).catch(() => {});
            }
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

/**
 * Handle !stable command using the older MPEG-2/PCM capture and transcoding path.
 */
async function handleStable(message: Message): Promise<void> { await requestClaim(message, "stable"); }
async function handleJoin(message: Message): Promise<void> { await requestClaim(message, "direct"); }
async function requestClaim(message: Message, mode: "direct" | "stable"): Promise<void> {
    const channel = requireJoinChannel(message);
    try { validateServerConfiguration(); }
    catch { throw new PermissionDeniedError("Streaming requires the web server and Discord OAuth configuration. Ask the operator to enable SERVER_ENABLED and configure DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI."); }
    const claim = streamClaims.request(message.guild!.id, channel.id, message.author.id, mode);
    const link = `${new URL(config.oauth.redirectUri).origin}/claim/${claim.id}`;
    await message.reply(`Sign in with the Discord account that sent this command, then start your personal browser: ${link}\nThis link expires in five minutes. Your browser screen will be visible to everyone watching the stream.`);
}

/**
 * Handle !leave command - leaves the current voice channel.
 */
async function handleLeave(message: Message): Promise<void> {
    const streamingService = getStreamingService();
    
    if (!streamingService) {
        throw new Error("Streaming service not initialized");
    }

    const { member, session } = requireActiveSession(message, true);
    if (!canControlSession(member, session)) {
        throw new PermissionDeniedError("You need control permission to stop this stream.");
    }

    logger.info(`Leave requested by ${message.author.tag}`);

    await streamClaims.stop();

    await message.reply("👋 Left the voice channel");
    logger.info("Left voice channel via command");
}

/**
 * Handle !url command - navigate to a URL.
 */
async function handleUrl(message: Message, args: string[]): Promise<void> {
    const { member, session } = requireActiveSession(message);
    if (session.startedBy !== member.id || !hasPermission(member, "join", session)) {
        throw new PermissionDeniedError("Only the browser owner with current join permission may change its URL.");
    }
    const url = args.join(" ");
    if (!url) {
        await message.reply("❌ Usage: `!url <url>`");
        return;
    }

    const verified = await verifyBrowserOwner(message.author.id, session.guildId, session.channelId);
    const current = requireActiveSession(message);
    if (current.session !== session || current.member.id !== session.startedBy || !hasPermission(verified, 'join', session)) {
        throw new PermissionDeniedError("Your browser session or join permission changed.");
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
\`!join\` - Request a login/claim link for H264 and browser audio (default)
\`!beta\` - Alias for \`!join\`
\`!stable\` - Request a login/claim link for the older MPEG-2/PCM capture path
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

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        await streamClaims.departing(oldState.id, oldState.guild.id, oldState.channelId);
    }
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

        await streamClaims.stop();

        logger.info("Auto-left voice channel (empty)");
    }
}
