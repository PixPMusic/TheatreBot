import type { GuildMember, Guild } from "@lng2004/discord.js-selfbot-v13";
import type { PermissionLevel, ServerPermissions, Session } from "../types/index.js";
import logger from "../utils/logger.js";

/**
 * In-memory storage for server permissions.
 * In production, this should be persisted to a database.
 */
const serverPermissions: Map<string, ServerPermissions> = new Map();

/**
 * Get permissions for a server, creating default if not exists.
 */
export function getServerPermissions(guildId: string): ServerPermissions {
    if (!serverPermissions.has(guildId)) {
        serverPermissions.set(guildId, {
            guildId,
            join: [],
            control: [],
            navigate: [],
            admin: [],
        });
    }
    return serverPermissions.get(guildId)!;
}

/**
 * Set role/user IDs for a permission level.
 */
export function setPermission(
    guildId: string, 
    level: PermissionLevel, 
    ids: string[]
): void {
    const perms = getServerPermissions(guildId);
    perms[level] = ids;
    serverPermissions.set(guildId, perms);
    logger.info(`Updated ${level} permissions for guild ${guildId}: ${ids.join(", ")}`);
}

/**
 * Add a role/user ID to a permission level.
 */
export function addPermission(
    guildId: string,
    level: PermissionLevel,
    id: string
): void {
    const perms = getServerPermissions(guildId);
    if (!perms[level].includes(id)) {
        perms[level].push(id);
        serverPermissions.set(guildId, perms);
        logger.info(`Added ${id} to ${level} permissions for guild ${guildId}`);
    }
}

/**
 * Remove a role/user ID from a permission level.
 */
export function removePermission(
    guildId: string,
    level: PermissionLevel,
    id: string
): void {
    const perms = getServerPermissions(guildId);
    perms[level] = perms[level].filter(i => i !== id);
    serverPermissions.set(guildId, perms);
    logger.info(`Removed ${id} from ${level} permissions for guild ${guildId}`);
}

/**
 * Check if a member is a server owner or has Administrator permission.
 */
function isServerAdmin(member: GuildMember): boolean {
    // Check if owner
    if (member.guild.ownerId === member.id) {
        return true;
    }
    
    // Check if has Administrator permission
    if (member.permissions.has("ADMINISTRATOR")) {
        return true;
    }
    
    return false;
}

/**
 * Check if a member has a specific permission level.
 */
export function hasPermission(
    member: GuildMember,
    level: PermissionLevel,
    session?: Session
): boolean {
    // Server admins always have all permissions
    if (isServerAdmin(member)) {
        return true;
    }

    const perms = getServerPermissions(member.guild.id);
    const allowedIds = perms[level];

    // Check if user ID is directly in the allowed list
    if (allowedIds.includes(member.id)) {
        return true;
    }

    // Check if any of the user's roles are in the allowed list
    for (const roleId of member.roles.cache.keys()) {
        if (allowedIds.includes(roleId)) {
            return true;
        }
    }

    // Special case for "join" permission with session ownership
    // Users with "join" can control sessions they started
    if (level === "control" && session) {
        if (session.startedBy === member.id) {
            // Check if they at least have "join" permission
            return hasPermission(member, "join");
        }
    }

    return false;
}

/**
 * Check if a user can control a specific session.
 * This accounts for session ownership.
 */
export function canControlSession(
    member: GuildMember,
    session: Session
): boolean {
    // Server admins can control any session
    if (isServerAdmin(member)) {
        return true;
    }

    // Session owner can always control their session
    if (session.startedBy === member.id) {
        return hasPermission(member, "join");
    }

    // Otherwise need control permission
    return hasPermission(member, "control");
}

/**
 * Check if a user can navigate (change URLs) in a session.
 */
export function canNavigate(
    member: GuildMember,
    session: Session,
    isPreset: boolean
): boolean {
    // Presets only require control permission
    if (isPreset) {
        return canControlSession(member, session);
    }

    // Arbitrary URLs require navigate permission
    return hasPermission(member, "navigate");
}

/**
 * Get all permissions for display.
 */
export function getAllPermissions(): Map<string, ServerPermissions> {
    return new Map(serverPermissions);
}

/**
 * Load permissions from a config object (for persistence).
 */
export function loadPermissions(data: Record<string, ServerPermissions>): void {
    for (const [guildId, perms] of Object.entries(data)) {
        serverPermissions.set(guildId, perms);
    }
    logger.info(`Loaded permissions for ${Object.keys(data).length} guilds`);
}

/**
 * Export permissions for persistence.
 */
export function exportPermissions(): Record<string, ServerPermissions> {
    const result: Record<string, ServerPermissions> = {};
    for (const [guildId, perms] of serverPermissions) {
        result[guildId] = perms;
    }
    return result;
}
