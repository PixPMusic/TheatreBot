import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createClient, logout } from '../dist/discord/client.js';
import { setupCommands } from '../dist/discord/commands.js';
import { initStreamingService } from '../dist/discord/streaming.js';
import { getBrowserControls } from '../dist/browser/controls.js';
import { getCaptureService } from '../dist/browser/capture.js';
import { getDirectStreamService } from '../dist/streaming/direct.js';
import { streamClaims } from '../dist/server/claims.js';
import config from '../dist/config.js';
import logger from '../dist/utils/logger.js';
import { loadPermissions } from '../dist/rbac/permissions.js';
const GUILD = '123456789012345678', VOICE = '223456789012345678';
const USER = '323456789012345678', OWNER = '423456789012345678', ROLE = '523456789012345678';
logger.silent = true;
const client = createClient(), streaming = initStreamingService(client);
setupCommands();
const dispatch = client.listeners('messageCreate').at(-1), voiceUpdate = client.listeners('voiceStateUpdate').at(-1);
after(logout);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness(t) {
    await streamClaims.stop(); streaming.leaveVoice();
    config.server.enabled = true;
    Object.assign(config.oauth, { clientId: 'test-app', clientSecret: 'test-secret', redirectUri: 'https://theatre.example/auth/callback' });
    loadPermissions({ [GUILD]: { join: [USER], navigate: [USER] } });
    const calls = [], replies = [], reactions = [];
    let joined = false;
    const guild = { id: GUILD, ownerId: OWNER, roles: { cache: new Map([[ROLE, { permissions: { has: () => false } }]]) }, voiceStates: { cache: new Map([[USER, { channelId: VOICE }]]) } };
    const member = { id: USER, guild, partial: false, roles: { cache: new Map([[ROLE, {}]]) }, permissions: { has: () => false }, voice: { channelId: VOICE, channel: { id: VOICE, guild, name: 'Test' } } };
    guild.members = { fetch: async options => { assert.deepEqual(options, { user: USER, force: true }); return member; } };
    client.guilds.cache.set(GUILD, guild);
    t.mock.method(streaming, 'getStatus', () => ({ joined, channelInfo: joined ? { guildId: GUILD, channelId: VOICE } : null }));
    t.mock.method(streaming, 'joinVoice', async () => { joined = true; calls.push('join'); });
    const createSession = streaming.createSession.bind(streaming), leaveVoice = streaming.leaveVoice.bind(streaming), beginTeardown = streaming.beginTeardown.bind(streaming);
    t.mock.method(streaming, 'beginTeardown', () => { joined = false; beginTeardown(); });
    t.mock.method(streaming, 'createSession', (...args) => { calls.push('session'); return createSession(...args); });
    t.mock.method(streaming, 'leaveVoice', () => { joined = false; calls.push('leave'); leaveVoice(); });
    t.mock.method(getBrowserControls(), 'initialize', async owner => { assert.equal(owner, USER); calls.push('browser'); });
    t.mock.method(getBrowserControls(), 'close', async () => { calls.push('close'); });
    t.mock.method(getBrowserControls(), 'navigateTo', async () => { calls.push('navigate'); });
    t.mock.method(getDirectStreamService(), 'startStream', async () => { calls.push('direct'); await new Promise(() => {}); });
    t.mock.method(getDirectStreamService(), 'stopAndWait', async () => { calls.push('stop-direct'); });
    t.mock.method(getCaptureService(), 'stopAndWait', async () => { calls.push('stop-capture'); });
    t.mock.method(getCaptureService(), 'startCapture', () => { calls.push('capture'); return new PassThrough(); });
    t.mock.method(streaming, 'startStream', async () => { calls.push('transcode'); await new Promise(() => {}); });
    t.after(async () => { await streamClaims.stop(); client.guilds.cache.delete(GUILD); loadPermissions({}); });
    const message = content => ({ content, guild, member: { ...member, voice: { ...member.voice } }, author: { bot: false, id: USER, tag: 'Tester' }, reply: async text => replies.push(text), react: async emoji => reactions.push(emoji), channel: { send: async () => {} } });
    const login = { id: 'test-login', user: { id: USER, username: 'Tester' }, csrf: 'test-csrf', expiresAt: Date.now() + 60000 };
    const claim = () => streamClaims.claim(streamClaims.pending().id, login, () => true);
    const start = async command => { await dispatch(message(command)); await claim(); };
    return { calls, replies, reactions, message, member, guild, claim, start, login };
}
for (const command of ['!join', '!beta', '!stable']) {
    test(`${command} only reserves a claim and never allocates browser, voice or capture`, async t => {
        const h = await harness(t); await dispatch(h.message(command));
        assert.deepEqual(h.calls, []); assert.ok(streaming.getPendingSession());
        assert.match(h.replies[0], /https:\/\/theatre\.example\/claim\/[a-f0-9]{64}/);
        assert.match(h.replies[0], /visible to everyone/); assert.deepEqual(h.reactions, ['✅']);
    });
    test(`${command} starts exactly its selected mode after the owner claims`, async t => {
        const h = await harness(t); await h.start(command);
        assert.deepEqual(h.calls, command === '!stable' ? ['browser', 'join', 'session', 'capture', 'transcode'] : ['browser', 'join', 'session', 'direct']);
        await dispatch(h.message('!leave'));
        assert.deepEqual(h.calls.slice(-4), ['stop-direct', 'stop-capture', 'close', 'leave']);
    });
    test(`${command} deduplicates the same pending request without extending expiry`, async t => {
        const h = await harness(t); await dispatch(h.message(command)); const first = streamClaims.pending();
        await dispatch(h.message(command)); assert.equal(streamClaims.pending(), first); assert.equal(h.replies[0], h.replies[1]); assert.deepEqual(h.calls, []);
    });
    test(`!leave cancels ${command} before claim and the locator cannot be replayed`, async t => {
        const h = await harness(t); await dispatch(h.message(command)); const id = streamClaims.pending().id;
        await dispatch(h.message('!leave')); assert.equal(streamClaims.pending(), undefined);
        await assert.rejects(streamClaims.claim(id, h.login, () => true), e => e.status === 409);
        assert.equal(h.calls.includes('browser'), false);
    });
    test(`!leave during ${command} browser startup delays reservation reuse until browser close`, async t => {
        const h = await harness(t), browser = deferred(), close = deferred();
        t.mock.method(getBrowserControls(), 'initialize', () => { h.calls.push('browser-old'); return browser.promise; });
        t.mock.method(getBrowserControls(), 'close', () => close.promise);
        await dispatch(h.message(command)); const start = h.claim(); await tick();
        const cancelled = assert.rejects(start, e => e.status === 409);
        const leave = dispatch(h.message('!leave')); await tick();
        await dispatch(h.message('!join')); assert.match(h.replies.at(-1), /Already streaming/);
        browser.resolve(); await cancelled; close.resolve(); await leave;
        t.mock.method(getBrowserControls(), 'initialize', async () => h.calls.push('browser-new'));
        t.mock.method(getBrowserControls(), 'close', async () => {});
        await h.start('!join'); assert.equal(h.calls.filter(c => c === 'session').length, 1);
    });
    test(`${command} denies an unconfigured ordinary user before reservation`, async t => {
        const h = await harness(t); loadPermissions({}); await dispatch(h.message(command));
        assert.deepEqual(h.calls, []); assert.equal(streamClaims.pending(), undefined); assert.match(h.replies[0], /join permission/);
    });
}
for (const disabled of ['server', 'oauth']) test(`!join explains missing ${disabled} configuration before reservation`, async t => {
    const h = await harness(t); if (disabled === 'server') config.server.enabled = false; else config.oauth.clientSecret = '';
    await dispatch(h.message('!join')); assert.deepEqual(h.calls, []); assert.equal(streamClaims.pending(), undefined); assert.match(h.replies[0], /requires the web server and Discord OAuth/);
});
for (const change of [m => { m.member = null; }, m => { m.member.id = OWNER; }, m => { m.member.guild = { id: '999', ownerId: USER }; }, m => { m.member.voice.channelId = null; }, m => { m.member.voice.channel.guild = { id: '999' }; }]) test('join validates guild/member/current voice before admin bypass', async t => {
    const h = await harness(t), message = h.message('!join'); message.member.permissions.has = () => true; change(message); await dispatch(message);
    assert.deepEqual(h.calls, []); assert.equal(streamClaims.pending(), undefined); assert.deepEqual(h.reactions, ['❌']);
});
for (const failure of ['browser', 'join', 'capture']) test(`${failure} startup failure closes browser and clears reservation before retry`, async t => {
    const h = await harness(t);
    if (failure === 'browser') t.mock.method(getBrowserControls(), 'initialize', async () => { throw new Error('failed'); });
    if (failure === 'join') t.mock.method(streaming, 'joinVoice', async () => { throw new Error('failed'); });
    if (failure === 'capture') t.mock.method(getCaptureService(), 'startCapture', () => { throw new Error('failed'); });
    await dispatch(h.message('!stable')); await assert.rejects(h.claim(), /failed/);
    assert.equal(streamClaims.pending(), undefined); assert.equal(streaming.getPendingSession(), undefined); assert.deepEqual(h.calls.slice(-4), ['stop-direct', 'stop-capture', 'close', 'leave']);
});
for (const mode of ['!join', '!stable']) test(`late ${mode} playback failure cannot stop a replacement`, async t => {
    const h = await harness(t), playback = deferred();
    t.mock.method(mode === '!join' ? getDirectStreamService() : streaming, mode === '!join' ? 'startStream' : 'startStream', () => playback.promise);
    await h.start(mode); await dispatch(h.message('!leave'));
    t.mock.method(getDirectStreamService(), 'startStream', async () => { h.calls.push('direct-new'); await new Promise(() => {}); });
    await h.start('!join');
    const expected = h.calls.slice(); playback.reject(new Error('old playback failure')); await tick(); assert.deepEqual(h.calls, expected);
});
for (const command of ['!url https://example.com', '!goto https://example.com']) test(`${command} is owner-only while admins may stop the stream`, async t => {
    const h = await harness(t); await h.start('!join'); h.calls.length = 0;
    const admin = h.message(command); admin.author.id = admin.member.id = OWNER; admin.member.permissions.has = () => true;
    await dispatch(admin); assert.deepEqual(h.calls, []); assert.match(h.replies.at(-1), /Only the browser owner/);
    admin.content = '!leave'; await dispatch(admin); assert.equal(h.calls.at(-1), 'leave');
});
test('owner has full navigation with join permission and loses it when join is revoked', async t => {
    const h = await harness(t); await h.start('!join'); h.calls.length = 0;
    loadPermissions({ [GUILD]: { join: [USER] } }); await dispatch(h.message('!url https://example.com')); assert.deepEqual(h.calls, ['navigate']);
    loadPermissions({}); await dispatch(h.message('!url https://example.com')); assert.deepEqual(h.calls, ['navigate']);
});
test('starter departure invalidates an unclaimed request', async t => {
    const h = await harness(t); await dispatch(h.message('!join')); const id = streamClaims.pending().id;
    await voiceUpdate({ id: USER, guild: h.guild, channelId: VOICE }, { id: USER, guild: h.guild, channelId: null });
    await assert.rejects(streamClaims.claim(id, h.login, () => true), e => e.status === 409); assert.equal(h.calls.includes('browser'), false);
});
test('teardown failure retains ownership and blocks replacement until authorized !leave retry', async t => {
    const h = await harness(t); await dispatch(h.message('!join'));
    let fail = true; t.mock.method(getBrowserControls(), 'close', async () => { if (fail) throw new Error('still running'); });
    await dispatch(h.message('!leave')); assert.ok(streaming.getPendingSession());
    await dispatch(h.message('!join')); assert.match(h.replies.at(-1), /Already streaming/);
    fail = false; await dispatch(h.message('!leave')); assert.equal(streaming.getPendingSession(), undefined);
});
test('help remains public without membership', async t => {
    const h = await harness(t), message = h.message('!help'); message.member = null; await dispatch(message);
    assert.match(h.replies[0], /login\/claim link/); assert.deepEqual(h.calls, []);
});

test('owner leaving an active voice channel stops capture and closes the personal browser', async t => {
    const h = await harness(t); await h.start('!join'); h.calls.length = 0;
    await voiceUpdate({ id: USER, guild: h.guild, channelId: VOICE }, { id: USER, guild: h.guild, channelId: null });
    assert.deepEqual(h.calls, ['stop-direct', 'stop-capture', 'close', 'leave']);
    assert.equal(streaming.getSession(`${GUILD}-${VOICE}`), undefined);
});

test('voice membership changed while claim verification waits prevents any browser allocation', async t => {
    const h = await harness(t), proof = deferred();
    t.mock.method(h.guild.members, 'fetch', () => proof.promise);
    await dispatch(h.message('!join')); const claimed = h.claim(), denied = assert.rejects(claimed, e => e.status === 403);
    await tick(); h.guild.voiceStates.cache.get(USER).channelId = '999999999999999999'; proof.resolve(h.member);
    await denied; assert.deepEqual(h.calls, []);
});
