import { readFileSync } from "node:fs";
import type { PermissionLevel, ServerPermissions, Session } from "../types/index.js";

/** Verified guild membership, shared by Discord commands and authenticated callers. */
export interface PermissionSubject {
    id: string;
    guild: { id: string; ownerId: string };
    roles: { cache: { keys(): IterableIterator<string> } };
    permissions: { has(permission: "ADMINISTRATOR"): boolean };
    voice: { channelId: string | null };
}

const levels: PermissionLevel[] = ["join", "control", "navigate", "admin"];
const snowflake = /^[1-9]\d{16,19}$/;
let serverPermissions = new Map<string, ServerPermissions>();

function emptyPermissions(guildId: string): ServerPermissions {
    return { guildId, join: [], control: [], navigate: [], admin: [] };
}

/** Returns a copy so callers cannot change the loaded access policy. */
export function getServerPermissions(guildId: string): ServerPermissions {
    const perms = serverPermissions.get(guildId) ?? emptyPermissions(guildId);
    return { ...perms, join: [...perms.join], control: [...perms.control], navigate: [...perms.navigate], admin: [...perms.admin] };
}

/** Validate the entire file before replacing policy; omitted levels deny ordinary users. */
export function loadPermissions(data: unknown): void {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Permissions must be a JSON object keyed by Discord guild ID");
    }
    const next = new Map<string, ServerPermissions>();
    for (const [guildId, value] of Object.entries(data)) {
        if (!snowflake.test(guildId)) throw new Error(`Invalid guild ID ${JSON.stringify(guildId)}; use a Discord snowflake string`);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`Permissions for guild ${guildId} must be an object`);
        }
        const perms = emptyPermissions(guildId);
        for (const [key, ids] of Object.entries(value)) {
            if (!levels.includes(key as PermissionLevel)) {
                throw new Error(`Unknown permission ${JSON.stringify(key)} for guild ${guildId}; allowed levels: ${levels.join(", ")}`);
            }
            if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !snowflake.test(id))) {
                throw new Error(`Permissions ${guildId}.${key} must be an array of Discord role/user ID strings`);
            }
            perms[key as PermissionLevel] = [...new Set(ids as string[])];
        }
        next.set(guildId, perms);
    }
    serverPermissions = next;
}

/** A configured unreadable or malformed file is fatal; absent configuration is admin-only. */
export function loadPermissionsFile(path: string | undefined): void {
    if (!path) {
        loadPermissions({});
        return;
    }
    try {
        loadPermissions(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
        throw new Error(`Cannot load PERMISSIONS_FILE ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}. Fix the file or unset PERMISSIONS_FILE to use admin-only access.`);
    }
}

function validSubject(subject: PermissionSubject): boolean {
    return typeof subject?.id === "string" && subject.id.length > 0
        && typeof subject.guild?.id === "string" && subject.guild.id.length > 0
        && typeof subject.guild.ownerId === "string" && subject.guild.ownerId.length > 0
        && typeof subject.roles?.cache?.keys === "function"
        && typeof subject.permissions?.has === "function"
        && (subject.voice?.channelId === null || (typeof subject.voice?.channelId === "string" && subject.voice.channelId.length > 0));
}

/** Check this before any administrator or session-owner shortcut. */
function inSession(subject: PermissionSubject, session: Session): boolean {
    return validSubject(subject) && subject.guild.id === session.guildId
        && subject.voice.channelId === session.channelId
        && session.id === `${session.guildId}-${session.channelId}`;
}

function matches(subject: PermissionSubject, ids: string[]): boolean {
    return ids.includes(subject.id) || Array.from(subject.roles.cache.keys()).some(id => ids.includes(id));
}

export function hasPermission(subject: PermissionSubject, level: PermissionLevel, session?: Session): boolean {
    if (!validSubject(subject) || (session && !inSession(subject, session))) return false;
    const perms = serverPermissions.get(subject.guild.id) ?? emptyPermissions(subject.guild.id);
    if (subject.guild.ownerId === subject.id || subject.permissions.has("ADMINISTRATOR") || matches(subject, perms.admin)) return true;
    if (matches(subject, perms[level])) return true;
    return level === "control" && session?.startedBy === subject.id && hasPermission(subject, "join");
}

/** Control grants and session ownership are restricted to the current guild and voice channel. */
export function canControlSession(subject: PermissionSubject, session: Session): boolean {
    return hasPermission(subject, "control", session);
}

/** Presets require control; arbitrary URLs require navigate, including for session owners. */
export function canNavigate(subject: PermissionSubject, session: Session, isPreset = false): boolean {
    return isPreset ? canControlSession(subject, session) : hasPermission(subject, "navigate", session);
}

export function getAllPermissions(): Map<string, ServerPermissions> {
    return new Map([...serverPermissions.keys()].map(id => [id, getServerPermissions(id)]));
}

export function exportPermissions(): Record<string, Omit<ServerPermissions, "guildId">> {
    return Object.fromEntries([...serverPermissions.keys()].map(id => {
        const { guildId: _guildId, ...perms } = getServerPermissions(id);
        return [id, perms];
    }));
}
