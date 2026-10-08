import { constants } from "node:fs";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, chmod, open, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export interface ProfileLease { directory: string; release(): Promise<void> }

export function validateProfileRoot(root: string): string {
    if (!path.isAbsolute(root)) throw new Error("BROWSER_PROFILE_ROOT must be absolute");
    const resolved = path.resolve(root);
    const application = fileURLToPath(new URL("../../", import.meta.url));
    const relation = path.relative(application, resolved);
    if (!relation || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation))) throw new Error("BROWSER_PROFILE_ROOT must be outside the application/build context");
    if ([path.parse(resolved).root, os.homedir(), os.tmpdir(), '/var', '/var/lib'].includes(resolved)) throw new Error("BROWSER_PROFILE_ROOT must be a dedicated private directory");
    return resolved;
}

/** Prepare only the private root; do not inspect or remove profiles or existing leases. */
export async function prepareProfileRoot(root: string): Promise<string> {
    let probe: { file: string; ino: number; dev: number } | undefined;
    try {
        const resolved = validateProfileRoot(root);
        // Reject symlinks in every existing component, including ancestors of the root.
        let current = path.parse(resolved).root;
        for (const component of resolved.slice(current.length).split(path.sep)) {
            current = path.join(current, component);
            try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Profile paths must not contain symlinks"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await mkdir(resolved, { recursive: true, mode: 0o700 });
        if (await realpath(resolved) !== resolved) throw new Error("Profile root escaped its configured path");
        await chmod(resolved, 0o700);
        const file = path.join(resolved, `.theatrebot-write-probe-${randomBytes(16).toString("hex")}`);
        const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            const identity = await handle.stat();
            probe = { file, ino: identity.ino, dev: identity.dev };
            await handle.writeFile("profile-root-writability-check");
        } finally { await handle.close(); }
        await fs.unlink(file);
        probe = undefined;
        return resolved;
    } catch (error) {
        // Clean up only this attempt's unique probe, and only while its inode still matches.
        if (probe) {
            const entry = await lstat(probe.file).catch(() => undefined);
            if (entry?.ino === probe.ino && entry.dev === probe.dev) await fs.unlink(probe.file).catch(() => {});
        }
        throw new Error(`Cannot prepare BROWSER_PROFILE_ROOT ${JSON.stringify(root)}: ${error instanceof Error ? error.message : String(error)}. Configure a private directory owned by the bot's OS user on writable persistent storage.`, { cause: error });
    }
}

/** Private owner directories and an exclusive on-disk lease; never import a shared profile. */
export async function acquireProfile(root: string, owner: string): Promise<ProfileLease> {
    if (!/^\d{1,20}$/.test(owner)) throw new Error("Invalid Discord profile owner");
    const resolved = await prepareProfileRoot(root);
    const directory = path.join(resolved, owner);
    await mkdir(directory, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error("Profile directory must be a real directory inside the profile root");
    }
    await chmod(directory, 0o700);
    const rootLock = path.join(resolved, ".theatrebot-browser-lease");
    const lock = path.join(directory, ".theatrebot-lease");
    const created: { file: string; ino: number; dev: number }[] = [];
    const removeOwned = async () => {
        for (const owned of [...created].reverse()) {
            const entry = await lstat(owned.file).catch(() => undefined);
            if (entry?.ino === owned.ino && entry.dev === owned.dev) await unlink(owned.file);
        }
    };
    try {
        for (const file of [rootLock, lock]) {
            const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                const identity = await handle.stat();
                created.push({ file, ino: identity.ino, dev: identity.dev });
                await handle.writeFile(JSON.stringify({ owner, supervisor: process.pid, createdAt: new Date().toISOString() }));
            } finally { await handle.close(); }
        }
    } catch (error) { await removeOwned(); throw error; }
    let released = false;
    return { directory, async release() { if (!released) { await removeOwned(); released = true; } } };
}
