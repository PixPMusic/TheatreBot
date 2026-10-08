import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamClaims } from '../dist/server/claims.js';
import { loadPermissions } from '../dist/rbac/permissions.js';
import logger from '../dist/utils/logger.js';
logger.silent = true;
const USER = '111111111111111111', GUILD = '222222222222222222', VOICE = '333333333333333333';
const login = { id: 'login', user: { id: USER, username: 'Tester' }, csrf: 'csrf', expiresAt: 10000 };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t) {
    let now = 0, valid = true, starts = 0, stops = 0, verify = async () => subject;
    const subject = { id: USER, guild: { id: GUILD, ownerId: '444444444444444444' }, voice: { channelId: VOICE }, roles: { cache: new Set() }, permissions: { has: () => false } };
    loadPermissions({ [GUILD]: { join: [USER] } });
    const claims = new StreamClaims({ reserve: () => ({ id: Symbol('reservation') }), verify: (...args) => verify(...args),
        start: async () => { starts++; }, stop: async () => { stops++; }, now: () => now, lifetimeMs: 60000 });
    t.after(async () => { await claims.stop(); loadPermissions({}); });
    const request = (owner = USER, channel = VOICE, mode = 'direct') => claims.request(GUILD, channel, owner, mode);
    return { claims, request, claim: id => claims.claim(id, login, () => valid), starts: () => starts, stops: () => stops, advance: ms => { now += ms; }, invalidate: () => { valid = false; }, verification: work => { verify = work; }, subject };
}
test('a leaked claim locator grants no ownership and causes no resources', async t => {
    const f = fixture(t), claim = f.request();
    await assert.rejects(f.claims.claim(claim.id, { ...login, user: { id: '555555555555555555' } }, () => true), e => e.status === 403);
    assert.equal(f.starts(), 0); assert.equal(f.claims.pending(), claim);
});
for (const state of ['expired', 'cancelled', 'logged-out', 'revoked']) test(`${state} claims never start resources`, async t => {
    const f = fixture(t), claim = f.request();
    if (state === 'expired') f.advance(60000);
    if (state === 'cancelled') await f.claims.stop();
    if (state === 'logged-out') f.invalidate();
    if (state === 'revoked') loadPermissions({});
    await assert.rejects(f.claim(claim.id), e => [401,403,409].includes(e.status)); assert.equal(f.starts(), 0);
});
for (const change of ['expiry', 'cancellation', 'identity', 'roles']) test(`claim revalidates ${change} after asynchronous role verification`, async t => {
    const f = fixture(t), claim = f.request(), proof = deferred(); f.verification(() => proof.promise);
    const pending = f.claim(claim.id), rejected = assert.rejects(pending, e => [401,403,409].includes(e.status));
    if (change === 'expiry') f.advance(60000);
    if (change === 'cancellation') await f.claims.stop();
    if (change === 'identity') f.invalidate();
    if (change === 'roles') loadPermissions({});
    proof.resolve(f.subject); await rejected; assert.equal(f.starts(), 0);
});
test('concurrent claims share verification but exactly one POST can transition to startup', async t => {
    const f = fixture(t), claim = f.request(), proof = deferred(); f.verification(() => proof.promise);
    const posted = Promise.allSettled([f.claim(claim.id), f.claim(claim.id)]);
    proof.resolve(f.subject); const results = await posted;
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.starts(), 1);
    await assert.rejects(f.claim(claim.id), e => e.status === 409);
});
for (const channel of [VOICE, '666666666666666666']) test('competing users/channels cannot reserve a second claim', async t => {
    const f = fixture(t); f.request(); assert.throws(() => f.request('555555555555555555', channel), e => e.status === 409); assert.equal(f.starts(), 0);
});
test('a bounded timer invalidates abandoned claims', async t => {
    let stopped = 0;
    const claims = new StreamClaims({ reserve: () => ({ id: Symbol() }), verify: async () => {}, start: async () => {}, stop: async () => { stopped++; }, lifetimeMs: 10 });
    claims.request(GUILD, VOICE, USER, 'direct');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(claims.pending(), undefined); assert.equal(stopped, 1);
});
