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

logger.silent = true;
const client = createClient();
const streaming = initStreamingService(client);
setupCommands();
const dispatch = client.listeners("messageCreate").at(-1);
after(logout);

function harness(t) {
    const calls = [];
    let joined = false;
    const capture = getCaptureService();
    const direct = getDirectStreamService();
    t.mock.method(streaming, "getStatus", () => ({ joined }));
    t.mock.method(streaming, "createSession", () => { calls.push("session"); });
    t.mock.method(streaming, "joinVoice", async (guild, channel) => {
        assert.equal(guild, "guild");
        assert.equal(channel, "voice");
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
    t.mock.method(streaming, "leaveVoice", () => { joined = false; calls.push("leave"); });
    const replies = [], reactions = [];
    const message = content => ({
        content, author: { bot: false, tag: "tester", id: "user" },
        guild: { id: "guild" }, member: { voice: { channel: { id: "voice", name: "Test" } } },
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
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.reactions, ["❌"]);

    t.mock.method(getBrowserControls(), "initialize", async () => { h.calls.push("browser"); });
    await dispatch(h.message("!join"));
    assert.deepEqual(h.calls, ["browser", "join", "session", "direct"]);
    assert.deepEqual(h.reactions, ["❌", "✅"]);
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0], /H264 \+ browser audio/);
});

test("!stable explicitly retains the older capture/transcoding path", async t => {
    const h = harness(t);
    await dispatch(h.message("!stable"));
    assert.deepEqual(h.calls, ["session", "browser", "join", "capture", "transcode"]);
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
