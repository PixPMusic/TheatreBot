import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createClient, logout } from "../dist/discord/client.js";
import { setupCommands } from "../dist/discord/commands.js";
import { initStreamingService } from "../dist/discord/streaming.js";
import { getBrowserControls } from "../dist/browser/controls.js";
import { getCaptureService } from "../dist/browser/capture.js";
import { getDirectStreamService } from "../dist/streaming/direct.js";
import logger from "../dist/utils/logger.js";
import { loadPermissions } from "../dist/rbac/permissions.js";

const GUILD = "123456789012345678", VOICE = "223456789012345678";
const USER = "323456789012345678", OWNER = "423456789012345678", ROLE = "523456789012345678";

logger.silent = true;
const client = createClient();
const streaming = initStreamingService(client);
setupCommands();
const dispatch = client.listeners("messageCreate").at(-1);
after(logout);

function harness(t) {
    const calls = [];
    let joined = false;
    const leaveVoice = streaming.leaveVoice.bind(streaming);
    leaveVoice();
    t.after(leaveVoice);
    loadPermissions({ [GUILD]: { join: [USER], control: [], navigate: [USER], admin: [] } });
    const capture = getCaptureService();
    const direct = getDirectStreamService();
    t.mock.method(streaming, "getStatus", () => ({ joined, channelInfo: joined ? { guildId: GUILD, channelId: VOICE } : null }));
    const createSession = streaming.createSession.bind(streaming);
    t.mock.method(streaming, "createSession", (guildId, channelId, startedBy) => {
        calls.push("session");
        return createSession(guildId, channelId, startedBy);
    });
    t.mock.method(streaming, "joinVoice", async (guild, channel) => {
        assert.equal(guild, GUILD);
        assert.equal(channel, VOICE);
        joined = true;
        calls.push("join");
    });
    t.mock.method(getBrowserControls(), "initialize", async () => { calls.push("browser"); });
    t.mock.method(direct, "startStream", async service => {
        assert.equal(service, streaming);
        calls.push("direct");
        // A running stream must not block the command or subsequent !leave.
        await new Promise(() => {});
    });
    t.mock.method(capture, "startCapture", () => { calls.push("capture"); return new PassThrough(); });
    t.mock.method(streaming, "startStream", async () => { calls.push("transcode"); });
    t.mock.method(direct, "stopStream", () => { calls.push("stop-direct"); });
    t.mock.method(capture, "stopCapture", () => { calls.push("stop-capture"); });
    t.mock.method(streaming, "leaveVoice", () => { joined = false; calls.push("leave"); leaveVoice(); });
    t.mock.method(getBrowserControls(), "navigateTo", async () => { calls.push("navigate"); });
    const replies = [], reactions = [];
    const guild = { id: GUILD, ownerId: OWNER };
    const message = content => ({
        content, author: { bot: false, tag: "tester", id: USER },
        guild, member: {
            id: USER, guild, roles: { cache: new Map([[ROLE, {}]]) }, permissions: { has: () => false },
            voice: { channelId: VOICE, channel: { id: VOICE, guild, name: "Test" } },
        },
        reply: async text => { replies.push(text); },
        react: async emoji => { reactions.push(emoji); },
        channel: { send: async () => {} },
    });
    return { calls, replies, reactions, message };
}

for (const command of ["!join", "!beta"]) {
    test(`${command} uses direct browser audio/video and leaves without awaiting playback`, { timeout: 1000 }, async t => {
        const h = harness(t);
        await dispatch(h.message(command));
        assert.deepEqual(h.calls, ["browser", "join", "session", "direct"]);
        assert.match(h.replies[0], /H264 \+ browser audio/);
        assert.doesNotMatch(h.replies[0], /Beta|Stable/);
        await dispatch(h.message("!leave"));
        assert.deepEqual(h.calls.slice(-3), ["stop-direct", "stop-capture", "leave"]);
        assert.deepEqual(h.reactions, ["✅", "✅"]);
    });
}

test("browser startup failure leaves !join disconnected and retryable", async t => {
    const h = harness(t);
    t.mock.method(getBrowserControls(), "initialize", async () => { throw new Error("browser failed"); });
    await dispatch(h.message("!join"));
    assert.deepEqual(h.calls, ["leave"]);
    assert.deepEqual(h.reactions, ["❌"]);

    t.mock.method(getBrowserControls(), "initialize", async () => { h.calls.push("browser"); });
    await dispatch(h.message("!join"));
    assert.deepEqual(h.calls, ["leave", "browser", "join", "session", "direct"]);
    assert.deepEqual(h.reactions, ["❌", "✅"]);
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0], /H264 \+ browser audio/);
});

test("!stable explicitly retains the older capture/transcoding path", async t => {
    const h = harness(t);
    await dispatch(h.message("!stable"));
    assert.deepEqual(h.calls, ["browser", "join", "session", "capture", "transcode"]);
    assert.match(h.replies[0], /Stable\/Slow Mode/);
});

test("command help describes the default, alias, and fallback", async t => {
    const h = harness(t);
    await dispatch(h.message("!help"));
    assert.match(h.replies[0], /`!join`.*H264.*default/);
    assert.match(h.replies[0], /`!beta` - Alias for `!join`/);
    assert.match(h.replies[0], /`!stable`.*MPEG-2\/PCM/);
    assert.deepEqual(h.calls, []);
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

for (const command of ["!join", "!beta", "!stable"]) {
    test(`${command} reserves browser startup against every competing mode`, async t => {
        const h = harness(t);
        const browser = deferred();
        t.mock.method(getBrowserControls(), "initialize", () => { h.calls.push("browser"); return browser.promise; });
        const first = dispatch(h.message(command));
        assert.deepEqual(streaming.getPendingSession(), {
            id: `${GUILD}-${VOICE}`, guildId: GUILD, channelId: VOICE, startedBy: USER,
            createdAt: streaming.getPendingSession().createdAt,
            currentUrl: streaming.getPendingSession().currentUrl,
        });
        for (const competing of ["!join", "!beta", "!stable"]) await dispatch(h.message(competing));
        assert.deepEqual(h.calls, ["browser"]);
        assert.equal(h.replies.filter(reply => /Already streaming or starting/.test(reply)).length, 3);
        browser.resolve();
        await first;
        assert.equal(h.calls.filter(call => call === "session").length, 1);
        assert.equal(streaming.getPendingSession(), undefined);
    });

    test(`!leave cancels ${command} during browser initialization without disrupting a replacement`, async t => {
        const h = harness(t);
        const browser = deferred();
        t.mock.method(getBrowserControls(), "initialize", () => { h.calls.push("browser-old"); return browser.promise; });
        const old = dispatch(h.message(command));
        await dispatch(h.message("!leave"));
        assert.equal(streaming.getPendingSession(), undefined);
        t.mock.method(getBrowserControls(), "initialize", async () => { h.calls.push("browser-new"); });
        await dispatch(h.message("!join"));
        const expected = h.calls.slice();
        browser.resolve();
        await old;
        assert.deepEqual(h.calls, expected);
        assert.equal(h.replies.filter(reply => /Now streaming/.test(reply)).length, 1);
    });
}

test("cancelled browser failure cannot tear down a replacement", async t => {
    const h = harness(t);
    const browser = deferred();
    t.mock.method(getBrowserControls(), "initialize", () => browser.promise);
    const old = dispatch(h.message("!join"));
    await dispatch(h.message("!leave"));
    t.mock.method(getBrowserControls(), "initialize", async () => {});
    await dispatch(h.message("!stable"));
    const expected = h.calls.slice();
    browser.reject(new Error("old browser failed"));
    await old;
    assert.deepEqual(h.calls, expected);
});

test("join failure never publishes a session or launches capture and allows retry", async t => {
    const h = harness(t);
    t.mock.method(streaming, "joinVoice", async () => { throw new Error("join failed"); });
    await dispatch(h.message("!stable"));
    assert.deepEqual(h.calls, ["browser", "leave"]);
    assert.deepEqual(h.reactions, ["❌"]);
    assert.equal(streaming.getPendingSession(), undefined);
    assert.ok(streaming.reserveStartup(GUILD, VOICE, USER));
});

test("capture startup failure clears the joined session", async t => {
    const h = harness(t);
    t.mock.method(getCaptureService(), "startCapture", () => { throw new Error("capture failed"); });
    await dispatch(h.message("!stable"));
    assert.deepEqual(h.calls, ["browser", "join", "session", "leave"]);
    assert.deepEqual(h.reactions, ["❌"]);
    assert.equal(streaming.hasPendingStartup(), false);
});

test("late direct playback failure cannot leave a replacement session", async t => {
    const h = harness(t);
    const playback = deferred();
    t.mock.method(getDirectStreamService(), "startStream", () => playback.promise);
    await dispatch(h.message("!join"));
    await dispatch(h.message("!leave"));
    await dispatch(h.message("!stable"));
    const expected = h.calls.slice();
    playback.reject(new Error("old playback failed"));
    await flush();
    assert.deepEqual(h.calls, expected);
});


for (const command of ["!join", "!stable"]) {
    for (const result of ["fulfill", "reject"]) {
        test(`!leave during ${command} voice joining blocks late ${result} from launching capture`, async t => {
            const h = harness(t);
            const transport = deferred();
            const regularJoin = streaming.joinVoice;
            t.mock.method(streaming, "joinVoice", () => { h.calls.push("join-old"); return transport.promise; });
            const old = dispatch(h.message(command));
            await flush();
            assert.deepEqual(h.calls, ["browser", "join-old"]);
            await dispatch(h.message("!leave"));
            t.mock.method(streaming, "joinVoice", regularJoin);
            await dispatch(h.message("!join"));
            const expected = h.calls.slice();
            if (result === "fulfill") transport.resolve();
            else transport.reject(new Error("old voice join failed"));
            await old;
            assert.deepEqual(h.calls, expected);
            assert.equal(h.calls.filter(call => call === "session").length, 1);
        });
    }
}

for (const command of ["!join", "!beta", "!stable"]) {
    test(`${command} denies unconfigured ordinary users before any browser/session/voice mutation`, async t => {
        const h = harness(t);
        loadPermissions({});
        await dispatch(h.message(command));
        assert.deepEqual(h.calls, []);
        assert.equal(streaming.getPendingSession(), undefined);
        assert.deepEqual(h.reactions, ["❌"]);
        assert.match(h.replies[0], /join permission/);
    });
}

test("join role grant works and help stays public without grants or voice membership", async t => {
    const h = harness(t);
    loadPermissions({ [GUILD]: { join: [ROLE] } });
    await dispatch(h.message("!join"));
    assert.deepEqual(h.calls, ["browser", "join", "session", "direct"]);
    loadPermissions({});
    const help = h.message("!help");
    help.member = null;
    await dispatch(help);
    assert.deepEqual(h.reactions, ["✅", "✅"]);
});

test("join validates guild/member/current voice before administrator bypass", async t => {
    const h = harness(t);
    for (const change of [
        message => { message.member = null; },
        message => { message.member.id = OWNER; },
        message => { message.member.guild = { id: "123456789012345679", ownerId: OWNER }; },
        message => { message.member.voice.channelId = null; },
        message => { message.member.voice.channelId = "223456789012345679"; },
        message => { message.member.voice.channel.guild = { id: "123456789012345679" }; },
    ]) {
        const message = h.message("!join");
        message.member.permissions.has = () => true;
        change(message);
        await dispatch(message);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.reactions, Array(6).fill("❌"));
    assert.equal(h.replies.length, 6);
});

for (const command of ["!leave", "!url https://example.com", "!goto https://example.com"]) {
    test(`${command} denies administrators outside the active session's guild or voice channel`, async t => {
        const h = harness(t);
        await dispatch(h.message("!join"));
        h.calls.length = h.replies.length = h.reactions.length = 0;
        for (const change of [
            message => { message.guild = message.member.guild = { id: "123456789012345679", ownerId: USER }; },
            message => { message.member.voice.channelId = "223456789012345679"; },
            message => { message.member.voice.channelId = null; },
        ]) {
            const message = h.message(command);
            message.member.permissions.has = () => true;
            change(message);
            await dispatch(message);
        }
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.reactions, ["❌", "❌", "❌"]);
        assert.equal(h.replies.length, 3);
    });
}

test("active-session lookup uses channelInfo, rejecting missing/mismatched sessions before administrator bypass", async t => {
    const h = harness(t);
    await dispatch(h.message("!join"));
    h.calls.length = h.replies.length = h.reactions.length = 0;
    let listReads = 0;
    t.mock.method(streaming, "getAllSessions", () => { listReads++; return []; });
    let returnedSession;
    t.mock.method(streaming, "getSession", id => {
        assert.equal(id, `${GUILD}-${VOICE}`);
        return returnedSession;
    });
    for (const session of [undefined, { id: `${GUILD}-223456789012345679`, guildId: GUILD, channelId: "223456789012345679", startedBy: USER }]) {
        returnedSession = session;
        for (const command of ["!leave", "!url https://example.com"]) {
            const message = h.message(command);
            message.member.permissions.has = () => true;
            await dispatch(message);
        }
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.reactions, Array(4).fill("❌"));
    assert.equal(listReads, 0);
});

test("session owner loses control on join revocation and cannot navigate without a navigate grant", async t => {
    const h = harness(t);
    await dispatch(h.message("!join"));
    h.calls.length = h.replies.length = h.reactions.length = 0;
    loadPermissions({ [GUILD]: { join: [USER] } });
    await dispatch(h.message("!url https://example.com"));
    loadPermissions({});
    await dispatch(h.message("!leave"));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.reactions, ["❌", "❌"]);
    assert.match(h.replies[0], /navigate permission/);
    assert.match(h.replies[1], /control permission/);
});

test("explicit control and navigate roles permit actions on a session started by another member", async t => {
    const h = harness(t);
    await dispatch(h.message("!join"));
    h.calls.length = h.replies.length = h.reactions.length = 0;
    t.mock.method(streaming, "getSession", () => ({ id: `${GUILD}-${VOICE}`, guildId: GUILD, channelId: VOICE, startedBy: OWNER }));
    loadPermissions({ [GUILD]: { control: [ROLE], navigate: [ROLE] } });
    await dispatch(h.message("!goto https://example.com"));
    await dispatch(h.message("!leave"));
    assert.deepEqual(h.calls, ["navigate", "stop-direct", "stop-capture", "leave"]);
    assert.deepEqual(h.reactions, ["✅", "✅"]);
});

for (const command of ["!join", "!beta", "!stable"]) {
    test(`${command} pending startup rejects outsider cancellation and URL changes without mutation`, async t => {
        const h = harness(t);
        const browser = deferred();
        t.mock.method(getBrowserControls(), "initialize", () => { h.calls.push("browser"); return browser.promise; });
        const first = dispatch(h.message(command));
        const pending = streaming.getPendingSession();
        for (const change of [
            message => { message.author.id = message.member.id = "623456789012345678"; },
            message => { message.guild = message.member.guild = { id: "123456789012345679", ownerId: USER }; message.member.permissions.has = () => true; },
            message => { message.member.voice.channelId = "223456789012345679"; message.member.permissions.has = () => true; },
            message => { message.member.voice.channelId = null; message.member.permissions.has = () => true; },
        ]) {
            const leave = h.message("!leave");
            change(leave);
            await dispatch(leave);
            assert.equal(streaming.getPendingSession(), pending);
            assert.deepEqual(h.calls, ["browser"]);
        }
        await dispatch(h.message("!url https://example.com"));
        assert.deepEqual(h.calls, ["browser"]);
        assert.deepEqual(h.reactions, Array(5).fill("❌"));
        await dispatch(h.message("!leave"));
        assert.equal(streaming.getPendingSession(), undefined);
        assert.deepEqual(h.calls, ["browser", "stop-direct", "stop-capture", "leave"]);
        browser.resolve();
        await first;
        assert.equal(h.calls.includes("join"), false);
    });
}

test("pending startup creator needs current join permission, while a same-channel control role may cancel it", async t => {
    const h = harness(t);
    const browser = deferred();
    t.mock.method(getBrowserControls(), "initialize", () => browser.promise);
    const first = dispatch(h.message("!join"));
    loadPermissions({});
    await dispatch(h.message("!leave"));
    assert.ok(streaming.getPendingSession());
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.reactions, ["❌"]);
    loadPermissions({ [GUILD]: { control: [ROLE] } });
    const leave = h.message("!leave");
    leave.author.id = leave.member.id = "623456789012345678";
    await dispatch(leave);
    assert.equal(streaming.getPendingSession(), undefined);
    assert.deepEqual(h.calls, ["stop-direct", "stop-capture", "leave"]);
    assert.deepEqual(h.reactions, ["❌", "✅"]);
    browser.resolve();
    await first;
});

test("retained pending ownership after teardown failure still denies outsiders and allows the authorized retry", async t => {
    const h = harness(t);
    const browser = deferred();
    t.mock.method(getBrowserControls(), "initialize", () => browser.promise);
    const first = dispatch(h.message("!join"));
    const pending = streaming.getPendingSession();
    const streamer = streaming.getStreamer();
    let failTeardown = true;
    let teardowns = 0;
    t.mock.getter(streamer, "voiceConnection", () => ({}));
    t.mock.method(streamer, "leaveVoice", () => {
        teardowns++;
        if (failTeardown) throw new Error("teardown failed");
    });
    await dispatch(h.message("!leave"));
    assert.equal(teardowns, 1);
    assert.equal(streaming.getPendingSession(), pending);
    assert.equal(streaming.hasPendingStartup(), true);
    const calls = h.calls.slice();
    const outsider = h.message("!leave");
    outsider.member.voice.channelId = "223456789012345679";
    outsider.member.permissions.has = () => true;
    await dispatch(outsider);
    assert.deepEqual(h.calls, calls);
    assert.equal(teardowns, 1);
    failTeardown = false;
    await dispatch(h.message("!leave"));
    assert.equal(teardowns, 2);
    assert.equal(streaming.getPendingSession(), undefined);
    assert.equal(streaming.hasPendingStartup(), false);
    assert.deepEqual(h.reactions, ["❌", "❌", "✅"]);
    browser.resolve();
    await first;
    assert.equal(h.calls.includes("join"), false);
});
