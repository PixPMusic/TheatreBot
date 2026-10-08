import { constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

/** Operator-owned local assets only. Never downloads or modifies extensions. */
export function resolveBrowserExtensions(raw: string): string[] {
    if (!raw.trim()) return [];
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("BROWSER_EXTENSION_PATHS must be a JSON array of absolute unpacked MV3 extension directories");
    }
    if (!Array.isArray(value)) {
        throw new Error("BROWSER_EXTENSION_PATHS must be a JSON array of absolute unpacked MV3 extension directories");
    }
    const paths: string[] = [];
    for (const [index, entry] of value.entries()) {
        const label = `BROWSER_EXTENSION_PATHS entry ${index + 1}`;
        // Chromium uses commas as separators. Control characters are never paths here.
        if (typeof entry !== "string" || !isAbsolute(entry) || /[,\x00-\x1f\x7f]/.test(entry)) {
            throw new Error(`${label} must be an absolute directory path without commas or control characters`);
        }
        let path: string;
        let manifest: unknown;
        try {
            path = realpathSync(entry);
            if (/[,\x00-\x1f\x7f]/.test(path) || !statSync(path).isDirectory()) throw new Error("invalid directory");
            manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
        } catch {
            throw new Error(`${label} must contain a readable, valid manifest.json in an existing directory`);
        }
        if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
            throw new Error(`${label} has an invalid extension manifest`);
        }
        const info = manifest as Record<string, unknown>;
        if (info.manifest_version !== 3 || typeof info.name !== "string" || !info.name.trim()
            || typeof info.version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(info.version)
            || !info.version.split(".").every(part => Number(part) <= 65535)
            || !info.version.split(".").some(part => Number(part) > 0)) {
            throw new Error(`${label} requires a Manifest V3 extension with a name and valid version; MV2 is unsupported`);
        }
        if (paths.includes(path)) throw new Error(`${label} duplicates another extension directory`);
        paths.push(path);
    }
    return paths;
}

/** Branded Chrome removed these switches; fail explicitly rather than silently ignoring them. */
export function validateExtensionBrowser(paths: readonly string[], binary: string): void {
    if (paths.length === 0) return;
    let version: string;
    try {
        version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
    } catch {
        throw new Error("Cannot verify extension-compatible browser: check CHROME_BIN points to Chromium or Chrome for Testing");
    }
    if (!/^(Chromium|Google Chrome for Testing)\b/.test(version)) {
        throw new Error("Unpacked MV3 extensions require Chromium or Chrome for Testing; branded Google Chrome does not support the loading switches");
    }
}

/**
 * Chromium indexes static DNR rules inside unpacked assets. Keep the operator's
 * originals immutable and give each leased profile its own writable copy.
 * Call only while holding exclusive ownership of profileDirectory.
 */
export async function stageBrowserExtensions(raw: string, profileDirectory: string): Promise<string[]> {
    const sources = resolveBrowserExtensions(raw);
    if (!sources.length) return [];
    if (!isAbsolute(profileDirectory)) throw new Error("Extension staging requires an absolute leased profile directory");
    const profile = await realpath(profileDirectory);
    if (/[,\x00-\x1f\x7f]/.test(profile)) throw new Error("Extension profile paths cannot contain commas or control characters");
    if (!(await lstat(profile)).isDirectory()) throw new Error("Extension staging requires a leased profile directory");
    const cache = join(profile, ".theatrebot-extensions");
    await mkdir(cache, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await requirePrivateDirectory(cache);
    const paths: string[] = [];
    for (const source of sources) {
        // Identity follows the fixed operator mount, not version, list order, or content.
        const identity = createHash("sha256").update(source).digest("hex");
        const destination = join(cache, identity);
        const pending = await mkdtemp(join(cache, ".pending-"));
        try {
            await copyExtensionDirectory(source, pending);
            const existing = await lstat(destination).catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            });
            if (existing) {
                await requirePrivateDirectory(destination);
                await rm(destination, { recursive: true });
            }
            await rename(pending, destination);
            paths.push(destination);
        } finally {
            await rm(pending, { recursive: true, force: true });
        }
    }
    return paths;
}

async function requirePrivateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) {
        throw new Error("Extension cache must be an owned private directory without symlinks");
    }
}

async function copyExtensionDirectory(source: string, destination: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = join(source, entry.name), to = join(destination, entry.name);
        const info = await lstat(from);
        if (info.isSymbolicLink()) throw new Error("Unpacked extension assets cannot contain symlinks");
        if (info.isDirectory()) {
            await mkdir(to, { mode: 0o700 });
            await copyExtensionDirectory(from, to);
        } else if (info.isFile()) {
            const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                if (!(await input.stat()).isFile()) throw new Error("Extension assets must contain only regular files and directories");
                const output = await open(to, "wx", 0o600);
                try { await output.writeFile(await input.readFile()); }
                finally { await output.close(); }
            } finally { await input.close(); }
        } else {
            throw new Error("Extension assets must contain only regular files and directories");
        }
    }
}
