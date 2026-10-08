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
    const leaveVoice = streaming.leaveVoice.bind(streaming);
    leaveVoice();
    t.after(leaveVoice);
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
    t.mock.method(streaming, "leaveVoice", () => { joined = false; calls.push("leave"); leaveVoice(); });
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
            id: "guild-voice", guildId: "guild", channelId: "voice", startedBy: "user",
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
    assert.ok(streaming.reserveStartup("guild", "voice", "user"));
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
