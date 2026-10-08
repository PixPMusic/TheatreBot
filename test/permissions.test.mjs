import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPermissions, loadPermissionsFile, hasPermission, canControlSession, canNavigate, getServerPermissions, getAllPermissions, exportPermissions } from "../dist/rbac/permissions.js";

const GUILD = "123456789012345678", OTHER_GUILD = "123456789012345679";
const CHANNEL = "223456789012345678", OTHER_CHANNEL = "223456789012345679";
const USER = "323456789012345678", OWNER = "423456789012345678", ROLE = "523456789012345678";
const session = { id: `${GUILD}-${CHANNEL}`, guildId: GUILD, channelId: CHANNEL, startedBy: USER, createdAt: new Date(), currentUrl: "about:blank" };
const levels = ["join", "control", "navigate", "admin"];
function subject({ id = USER, guildId = GUILD, channelId = CHANNEL, admin = false, roles = [ROLE] } = {}) {
    return { id, guild: { id: guildId, ownerId: OWNER }, voice: { channelId },
        roles: { cache: new Map(roles.map(role => [role, {}])) }, permissions: { has: value => value === "ADMINISTRATOR" && admin } };
}

test("unconfigured guilds allow only server owners and Administrators", () => {
    loadPermissions({});
    for (const level of levels) {
        assert.equal(hasPermission(subject(), level), false);
        assert.equal(hasPermission(subject({ id: OWNER }), level), true);
        assert.equal(hasPermission(subject({ admin: true }), level), true);
    }
});

test("direct user and role grants are per-guild and per-level; configured admins grant all levels", () => {
    loadPermissions({ [GUILD]: { join: [ROLE], navigate: [USER] } });
    assert.equal(hasPermission(subject(), "join"), true);
    assert.equal(hasPermission(subject(), "navigate"), true);
    assert.equal(hasPermission(subject(), "control"), false);
    assert.equal(hasPermission(subject({ roles: [] }), "join"), false);
    assert.equal(hasPermission(subject({ guildId: OTHER_GUILD }), "navigate"), false);
    for (const id of [USER, ROLE]) {
        loadPermissions({ [GUILD]: { admin: [id] } });
        for (const level of levels) assert.equal(hasPermission(subject(), level), true);
    }
});

test("session creator needs current join grant for control and presets, and navigate for arbitrary URLs", () => {
    loadPermissions({ [GUILD]: { join: [USER] } });
    assert.equal(canControlSession(subject(), session), true);
    assert.equal(canNavigate(subject(), session, true), true);
    assert.equal(canNavigate(subject(), session), false);
    assert.equal(canControlSession(subject(), { ...session, startedBy: OWNER }), false);
    loadPermissions({ [GUILD]: { navigate: [USER] } });
    assert.equal(canControlSession(subject(), session), false);
    assert.equal(canNavigate(subject(), session), true);
});

test("session boundaries precede all owner/admin shortcuts and explicit grants", () => {
    loadPermissions({ [GUILD]: { admin: [ROLE], control: [USER], navigate: [USER] }, [OTHER_GUILD]: { admin: [USER] } });
    for (const options of [{}, { id: OWNER }, { admin: true }]) {
        for (const wrongScope of [{ guildId: OTHER_GUILD }, { channelId: OTHER_CHANNEL }, { channelId: null }]) {
            const member = subject({ ...options, ...wrongScope });
            assert.equal(canControlSession(member, session), false);
            assert.equal(canNavigate(member, session), false);
            assert.equal(canNavigate(member, session, true), false);
        }
        const member = subject(options);
        assert.equal(canControlSession(member, { ...session, id: "stale-session" }), false);
        assert.equal(canNavigate(member, { ...session, guildId: OTHER_GUILD }), false);
    }
    assert.equal(hasPermission({ ...subject({ admin: true }), id: "" }, "join"), false);
    assert.equal(hasPermission({ ...subject({ admin: true }), roles: undefined }, "join"), false);
});

test("permission validation rejects malformed policy atomically, and policy reads cannot mutate grants", () => {
    loadPermissions({ [GUILD]: { join: [USER, USER] } });
    const invalid = [null, [], "policy", { guild: {} }, { [GUILD]: [] }, { [GUILD]: { typo: [] } },
        { [GUILD]: { join: "everyone" } }, { [GUILD]: { join: [323456789012345678] } },
        { [GUILD]: { join: ["user"] } }, { [GUILD]: { guildId: GUILD } },
        { [OTHER_GUILD]: { admin: [USER] }, [GUILD]: { join: [null] } }];
    for (const value of invalid) {
        assert.throws(() => loadPermissions(value));
        assert.equal(hasPermission(subject(), "join"), true);
        assert.equal(hasPermission(subject({ guildId: OTHER_GUILD }), "admin"), false);
    }
    assert.deepEqual(getServerPermissions(GUILD).join, [USER]);
    getServerPermissions(GUILD).admin.push(USER);
    getAllPermissions().get(GUILD).admin.push(USER);
    exportPermissions()[GUILD].admin.push(USER);
    assert.equal(hasPermission(subject(), "admin"), false);
    const exported = exportPermissions();
    loadPermissions(exported);
    assert.equal(hasPermission(subject(), "join"), true);
    loadPermissions({});
    assert.equal(hasPermission(subject(), "join"), false);
});

test("optional policy file is admin-only; configured read/JSON/schema errors identify the file and fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "theatrebot-permissions-"));
    const file = join(dir, "permissions.json");
    try {
        loadPermissionsFile(undefined);
        assert.equal(hasPermission(subject(), "join"), false);
        assert.throws(() => loadPermissionsFile(file), /Cannot load PERMISSIONS_FILE.*permissions\.json.*Fix the file/);
        writeFileSync(file, "{");
        assert.throws(() => loadPermissionsFile(file), /Cannot load PERMISSIONS_FILE/);
        writeFileSync(file, JSON.stringify({ [GUILD]: { admin: "everyone" } }));
        assert.throws(() => loadPermissionsFile(file), /must be an array.*Fix the file/);
        writeFileSync(file, JSON.stringify({ [GUILD]: { join: [USER] } }));
        loadPermissionsFile(file);
        assert.equal(hasPermission(subject(), "join"), true);
        loadPermissionsFile("");
        assert.equal(hasPermission(subject(), "join"), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});


test("malformed configured policy fails startup before Discord login", () => {
    const dir = mkdtempSync(join(tmpdir(), "theatrebot-permissions-startup-"));
    const file = join(dir, "permissions.json");
    try {
        writeFileSync(file, JSON.stringify({ [GUILD]: { admin: "everyone" } }));
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
            env: { ...process.env, TOKEN: "not-a-token", PERMISSIONS_FILE: file },
            encoding: "utf8", timeout: 5000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        const output = result.stdout + result.stderr;
        assert.match(output, /Cannot load PERMISSIONS_FILE/);
        assert.match(output, /must be an array of Discord role\/user ID strings/);
        assert.doesNotMatch(output, /Logging in to Discord/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
