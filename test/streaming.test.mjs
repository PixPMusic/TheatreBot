import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { StreamingService, stableStreamOptions } from "../dist/discord/streaming.js";
import { DirectStreamService, directStreamArguments } from "../dist/streaming/direct.js";
import config from "../dist/config.js";
import logger from "../dist/utils/logger.js";
logger.silent = true;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(play = () => new Promise(() => {})) {
    const sources = [];
    const streamer = {
        voiceConnection: {}, stops: 0, creations: 0, leaves: 0,
        createStream() { this.creations++; return Promise.resolve({ close() {} }); },
        stopStream() { this.stops++; },
        leaveVoice() { this.leaves++; },
    };
    const service = new StreamingService(null, {
        streamer,
        prepareStream(input, options, signal) {
            const completion = deferred();
            const output = new PassThrough();
            sources.push({ input, options, signal, completion, output });
            return { output, promise: completion.promise };
        },
        playStream: play,
    });
    // The mocked transport is already joined; these tests exercise media lifecycle.
    service.streamStatus.joined = true;
    return { service, sources, streamer };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("stable config uses v7 encoder settings and NUT playback with previews disabled", async () => {
    let playbackOptions;
    const { service, sources } = harness(async (_output, _streamer, options) => { playbackOptions = options; });
    const completion = service.startStream("capture.mkv");
    const options = sources[0].options;
    assert.equal(options.frameRate, config.stream.fps);
    assert.equal(options.minimizeLatency, false);
    assert.ok(options.customInputOptions.includes("-flags low_delay"));
    assert.equal(options.videoCodec, config.stream.videoCodec);
    for (const codec of ["H264", "H265"]) {
        const encoder = options.encoder(1000, 2000)[codec];
        assert.ok(encoder.options.includes(`-preset ${config.stream.h26xPreset}`));
        assert.ok(encoder.options.includes("-tune zerolatency"));
    }
    for (const removed of ["h26xPreset", "rtcpSenderReportEnabled", "readAtNativeFps", "forceChacha20Encryption"]) {
        assert.ok(!(removed in stableStreamOptions()));
    }
    assert.deepEqual(playbackOptions, { type: "go-live", format: "nut", streamPreview: false });
    sources[0].completion.resolve();
    await completion;
    assert.equal(service.getStatus().playing, false);
    assert.ok(sources[0].output.destroyed);
});

test("producer rejection aborts playback and releases capture", { timeout: 1000 }, async () => {
    let cleaned = 0;
    const { service, sources } = harness();
    const pending = service.startStream("source", () => cleaned++);
    const failed = assert.rejects(pending, /capture failed/);
    sources[0].completion.reject(new Error("capture failed"));
    await failed;
    assert.ok(sources[0].signal.aborted);
    assert.equal(cleaned, 1);
    assert.equal(service.getStatus().playing, false);
});

test("playback rejection aborts its producer", { timeout: 1000 }, async () => {
    const { service, sources } = harness(async () => { throw new Error("transport failed"); });
    await assert.rejects(service.startStream("source"), /transport failed/);
    assert.ok(sources[0].signal.aborted);
    sources[0].completion.reject(new Error("producer aborted"));
    await flush();
});

test("stop settles even if playback or the producer ignores cancellation", { timeout: 1000 }, async () => {
    const { service, sources, streamer } = harness();
    const pending = service.startStream("source");
    service.stopStream();
    await pending;
    assert.equal(service.getStatus().playing, false);
    assert.equal(service.getStatus().manualStop, true);
    assert.ok(sources[0].signal.aborted);
    assert.equal(streamer.stops, 1);
});

test("late playback cleanup and producer rejection cannot stop a replacement", { timeout: 1000 }, async () => {
    const runs = [];
    const { service, sources, streamer } = harness((_output, guarded, _options, signal) => {
        const completion = deferred();
        runs.push({ completion, guarded, signal });
        return completion.promise;
    });
    const first = service.startStream("first");
    const second = service.startStream("second");
    await first;
    assert.equal(service.getStatus().playing, true);
    assert.equal(streamer.stops, 1);
    runs[0].guarded.stopStream();
    runs[0].completion.reject(new Error("old playback aborted late"));
    sources[0].completion.reject(new Error("old producer aborted late"));
    await flush();
    assert.equal(streamer.stops, 1);
    assert.ok(!runs[1].signal.aborted);
    assert.equal(service.getStatus().playing, true);
    service.stopStream();
    await second;
});

test("delayed demux cannot create a stream after stop", { timeout: 1000 }, async () => {
    const demux = deferred();
    const { service, streamer } = harness(async (_output, guarded) => {
        await demux.promise;
        await guarded.createStream();
    });
    const pending = service.startStream("source");
    service.stopStream();
    await pending;
    demux.resolve();
    await flush();
    assert.equal(streamer.creations, 0);
});

test("abort during createStream settles and closes only the late connection", { timeout: 1000 }, async () => {
    const creation = deferred();
    let closed = 0;
    const { service, streamer } = harness(async (_output, guarded) => { await guarded.createStream(); });
    let replacementClosed = 0;
    streamer.createStream = function () {
        this.creations++;
        return this.creations === 1 ? creation.promise : Promise.resolve({ close() { replacementClosed++; } });
    };
    const pending = service.startStream("source");
    assert.equal(streamer.creations, 1);
    service.stopStream();
    await pending;
    const next = service.startStream("replacement");
    creation.resolve({ close() { closed++; } });
    await flush();
    assert.equal(closed, 1);
    assert.equal(replacementClosed, 0);
    assert.equal(streamer.stops, 1);
    assert.equal(service.getStatus().playing, true);
    service.stopStream();
    await next;
});

test("source error fails and cleans stable capture while demux waits", { timeout: 1000 }, async () => {
    const input = new PassThrough();
    const { service, sources } = harness();
    const pending = service.startStream(input);
    const failed = assert.rejects(pending, /input failed/);
    input.destroy(new Error("input failed"));
    await failed;
    assert.ok(sources[0].signal.aborted);
});

test("synchronous preparation failure cleans capture and clears playing", async () => {
    let cleaned = 0;
    const { service } = harness();
    service.media.prepareStream = () => { throw new Error("invalid input"); };
    await assert.rejects(service.startStream("source", () => cleaned++), /invalid input/);
    assert.equal(cleaned, 1);
    assert.equal(service.getStatus().playing, false);
});

test("beta capture maps browser video/audio with one H264 encode and Opus", () => {
    const args = directStreamArguments();
    const value = key => args[args.indexOf(key) + 1];
    const videoInputEnd = args.indexOf("-i");
    const videoOptions = args.slice(0, videoInputEnd);
    const remainingOptions = args.slice(videoInputEnd + 2);
    for (const [option, expected] of [["-probesize", "32"], ["-analyzeduration", "0"], ["-fflags", "nobuffer"]]) {
        const position = videoOptions.indexOf(option);
        assert.ok(position >= 0 && position < videoOptions.indexOf("-f"));
        assert.equal(videoOptions[position + 1], expected);
        assert.ok(!remainingOptions.includes(option));
    }
    assert.equal(value("-c:v"), "libx264");
    assert.equal(value("-c:a"), "libopus");
    assert.equal(value("-ar"), "48000");
    assert.equal(value("-frame_duration"), "20");
    assert.equal(value("-bf"), "0");
    assert.equal(value("-g"), String(config.stream.fps));
    assert.ok(args.includes("0:v:0") && args.includes("1:a:0"));
    assert.ok(!args.includes("-an"));
    assert.equal(args[args.lastIndexOf("-f") + 1], "nut");
    assert.equal(args.at(-1), "pipe:1");
});

function fakeProcess() {
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.exitCode = null;
    process.signalCode = null;
    process.kills = 0;
    process.kill = () => { process.kills++; return true; };
    return process;
}

test("beta rejects process errors and playback failures, killing only that capture", { timeout: 1000 }, async () => {
    const child = fakeProcess();
    const direct = new DirectStreamService(() => child);
    const { service } = harness();
    const pending = direct.startStream(service);
    const failed = assert.rejects(pending, /spawn failed/);
    child.emit("error", new Error("spawn failed"));
    await failed;
    assert.equal(direct.isRunning(), true);
    child.emit("close", 1, "SIGTERM");
    assert.equal(direct.isRunning(), false);
    assert.equal(child.kills, 1);
    assert.equal(service.getStatus().playing, false);
});

test("beta stop blocks replacement until process exit and old playback cleanup cannot stop a replacement", { timeout: 1000 }, async () => {
    const children = [fakeProcess(), fakeProcess()];
    let spawned = 0;
    const direct = new DirectStreamService(() => children[spawned++]);
    const { service } = harness();
    const first = direct.startStream(service);
    direct.stopStream();
    await assert.rejects(direct.startStream(service), /Stream already running/);
    await first;
    children[0].emit("close", 1, "SIGTERM");
    const second = direct.startStream(service);
    await flush();
    assert.equal(direct.isRunning(), true);
    assert.equal(service.getStatus().playing, true);
    assert.equal(children[1].kills, 0);
    direct.stopStream();
    await second;
    assert.equal(children[1].kills, 1);
});

test("leave aborts playback and clears voice state", { timeout: 1000 }, async () => {
    const { service, streamer } = harness();
    const pending = service.startStream("source");
    service.leaveVoice();
    await pending;
    assert.equal(streamer.leaves, 1);
    assert.equal(service.getStatus().joined, false);
    assert.equal(service.getStatus().playing, false);
});


test("beta EOF waits for playback to drain before clearing state", { timeout: 1000 }, async () => {
    const child = fakeProcess();
    const played = deferred();
    const direct = new DirectStreamService(() => child);
    let options;
    const { service } = harness((_output, _streamer, playbackOptions) => {
        options = playbackOptions;
        return played.promise;
    });
    const pending = direct.startStream(service);
    assert.equal(options.format, "nut");
    assert.equal(options.streamPreview, false);
    child.exitCode = 0;
    child.emit("close", 0, null);
    await flush();
    assert.equal(service.getStatus().playing, true);
    played.resolve();
    await pending;
    assert.equal(service.getStatus().playing, false);
    assert.equal(direct.isRunning(), false);
    assert.equal(child.kills, 0);
});


test("beta refuses an unjoined voice service and stops the spawned source", async () => {
    const child = fakeProcess();
    const direct = new DirectStreamService(() => child);
    const { service } = harness();
    service.streamStatus.joined = false;
    await assert.rejects(direct.startStream(service), /Not connected/);
    assert.equal(child.kills, 1);
    assert.equal(direct.isRunning(), true);
    child.emit("close", 1, "SIGTERM");
    assert.equal(direct.isRunning(), false);
    child.emit("error", new Error("late child error"));
    await flush();
});


function voiceHarness() {
    const joins = [];
    const settles = [];
    const streamer = {
        voiceConnection: undefined, leaves: 0, stops: 0,
        joinVoice(guild, channel) {
            const completion = deferred();
            const wrapper = { closes: 0, close() { this.closes++; } };
            const connection = { guild, channel, wrapper };
            this.voiceConnection = connection;
            joins.push({ completion, connection, wrapper });
            return completion.promise;
        },
        stopStream() { this.stops++; },
        leaveVoice() {
            this.leaves++;
            this.voiceConnection?.wrapper.close();
            this.voiceConnection = undefined;
        },
    };
    const service = new StreamingService(null, {
        streamer,
        waitForVoice: () => {
            const wait = deferred();
            settles.push(wait);
            return wait.promise;
        },
    });
    return { service, streamer, joins, settles };
}

test("voice joins reject overlap, including the same channel, and publish only after stabilization", async () => {
    const { service, streamer, joins, settles } = voiceHarness();
    const first = service.joinVoice("guild", "voice");
    await assert.rejects(service.joinVoice("guild", "voice"), /already in progress/);
    await assert.rejects(service.joinVoice("guild", "other"), /already in progress/);
    assert.equal(joins.length, 1);
    assert.equal(service.getStatus().joined, false);
    assert.equal(service.getStatus().channelInfo, null);
    joins[0].completion.resolve(joins[0].wrapper);
    await flush();
    assert.equal(service.getStatus().joined, false);
    settles[0].resolve();
    await first;
    assert.equal(service.getStatus().joined, true);
    assert.deepEqual(service.getStatus().channelInfo, { guildId: "guild", channelId: "voice" });
    await service.joinVoice("guild", "voice");
    await assert.rejects(service.joinVoice("other-guild", "voice"), /leave first/);
    assert.equal(joins.length, 1);
    service.createSession("guild", "voice", "user");
    service.leaveVoice();
    assert.equal(streamer.leaves, 1);
    assert.deepEqual(service.getAllSessions(), []);
});

for (const result of ["fulfill", "reject"]) {
    test(`leave while transport joins releases startup and isolates late ${result}`, { timeout: 1000 }, async () => {
        const { service, streamer, joins, settles } = voiceHarness();
        const reservation = service.reserveStartup("guild", "voice", "user");
        const first = service.joinVoice("guild", "voice", reservation);
        const cancelled = assert.rejects(first, /cancelled/);
        service.leaveVoice();
        await cancelled;
        assert.equal(streamer.leaves, 1);
        assert.equal(joins[0].wrapper.closes, 1);
        assert.equal(service.getPendingSession(), undefined);
        assert.equal(service.getStatus().joined, false);
        const replacement = service.reserveStartup("guild", "other", "other-user");
        const next = service.joinVoice("guild", "other", replacement);
        assert.equal(joins.length, 2);
        if (result === "fulfill") joins[0].completion.resolve(joins[0].wrapper);
        else joins[0].completion.reject(new Error("old join failed"));
        await flush();
        assert.equal(streamer.leaves, 1);
        assert.equal(streamer.voiceConnection, joins[1].connection);
        assert.equal(joins[1].wrapper.closes, 0);
        assert.equal(service.isStartupCurrent(replacement), true);
        assert.equal(service.getPendingSession().startedBy, "other-user");
        assert.equal(settles.length, 0);
        joins[1].completion.resolve(joins[1].wrapper);
        await flush();
        settles[0].resolve();
        await next;
        service.createSession("guild", "other", "other-user");
        service.completeStartup(replacement);
        assert.equal(service.hasPendingStartup(), false);
        assert.equal(service.getPendingSession(), undefined);
        service.cancelStartup(reservation);
        assert.equal(service.getStatus().joined, true);
        assert.equal(service.getAllSessions().length, 1);
        service.cleanup();
    });
}

test("cleanup during stabilization settles immediately and old timer cannot overwrite a replacement", { timeout: 1000 }, async () => {
    const { service, streamer, joins, settles } = voiceHarness();
    const first = service.joinVoice("guild", "voice");
    const cancelled = assert.rejects(first, /cancelled/);
    joins[0].completion.resolve(joins[0].wrapper);
    await flush();
    assert.equal(settles.length, 1);
    service.cleanup();
    await cancelled;
    const next = service.joinVoice("guild", "replacement");
    joins[1].completion.resolve(joins[1].wrapper);
    await flush();
    settles[1].resolve();
    await next;
    settles[0].resolve();
    await flush();
    assert.equal(streamer.leaves, 1);
    assert.deepEqual(service.getStatus().channelInfo, { guildId: "guild", channelId: "replacement" });
    service.leaveVoice();
});

for (const failure of ["transport", "missing-connection", "stabilization"]) {
    test(`${failure} failure tears down transport and clears stale session state`, async () => {
        const { service, streamer, joins, settles } = voiceHarness();
        service.createSession("old", "old", "user");
        const pending = service.joinVoice("guild", "voice");
        const failed = assert.rejects(pending, /failed|establish/);
        if (failure === "transport") joins[0].completion.reject(new Error("transport failed"));
        else {
            joins[0].completion.resolve(joins[0].wrapper);
            await flush();
            if (failure === "missing-connection") {
                streamer.voiceConnection = undefined;
                settles[0].resolve();
            } else settles[0].reject(new Error("stabilization failed"));
        }
        await failed;
        assert.equal(streamer.leaves, 1);
        assert.equal(service.getStatus().joined, false);
        assert.equal(service.hasPendingStartup(), false);
        assert.deepEqual(service.getAllSessions(), []);
        assert.ok(service.reserveStartup("guild", "voice", "user"));
        service.cleanup();
    });
}

test("failed synchronous teardown blocks replacement until teardown succeeds", async () => {
    const { service, streamer } = voiceHarness();
    const reservation = service.reserveStartup("guild", "voice", "user");
    const first = service.joinVoice("guild", "voice", reservation);
    const cancelled = assert.rejects(first, /cancelled/);
    const leaveVoice = streamer.leaveVoice.bind(streamer);
    streamer.leaveVoice = () => { throw new Error("teardown failed"); };
    assert.throws(() => service.leaveVoice(), /teardown failed/);
    await cancelled;
    assert.equal(service.reserveStartup("guild", "other", "user"), null);
    assert.equal(service.getPendingSession().startedBy, "user");
    await assert.rejects(service.joinVoice("guild", "other"), /already in progress/);
    streamer.leaveVoice = leaveVoice;
    service.leaveVoice();
    assert.equal(service.getPendingSession(), undefined);
    assert.ok(service.reserveStartup("guild", "other", "user"));
    service.cleanup();
});


test("cleanup cancels browser reservation and rejects its old token without touching a replacement", async () => {
    const { service, joins } = voiceHarness();
    const old = service.reserveStartup("guild", "voice", "user");
    service.cleanup();
    const replacement = service.reserveStartup("guild", "other", "other-user");
    await assert.rejects(service.joinVoice("guild", "voice", old), /already in progress|cancelled/);
    service.completeStartup(old);
    service.cancelStartup(old);
    assert.equal(joins.length, 0);
    assert.equal(service.hasPendingStartup(), true);
    assert.equal(service.isStartupCurrent(replacement), true);
    assert.equal(service.getPendingSession().startedBy, "other-user");
    service.cleanup();
});
