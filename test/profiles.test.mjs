import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, lstat, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireProfile } from '../dist/browser/profiles.js';
const OWNER = '111111111111111111';
async function fixture(t) { const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'theatrebot-profiletest-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('profiles and root are private; exclusive lease release preserves site data', async t => {
    const root = await fixture(t), lease = await acquireProfile(root, OWNER);
    assert.equal((await lstat(root)).mode & 0o777, 0o700); assert.equal((await lstat(lease.directory)).mode & 0o777, 0o700);
    await writeFile(path.join(lease.directory, 'cookies-fixture'), 'persisted');
    await assert.rejects(acquireProfile(root, OWNER), e => e.code === 'EEXIST');
    await lease.release(); const next = await acquireProfile(root, OWNER);
    assert.equal(await readFile(path.join(next.directory, 'cookies-fixture'), 'utf8'), 'persisted'); await next.release();
});
for (const owner of ['../escape', '/absolute', 'name', '1/2', '', '1'.repeat(21)]) test(`invalid profile owner ${JSON.stringify(owner)} cannot escape the root`, async t => {
    const root = await fixture(t); await assert.rejects(acquireProfile(root, owner), /Invalid Discord/);
});
test('profile directory symlinks and existing files are rejected', async t => {
    const root = await fixture(t); await mkdir(path.join(root, 'target')); await symlink(path.join(root, 'target'), path.join(root, OWNER));
    await assert.rejects(acquireProfile(root, OWNER), /real directory/); await rm(path.join(root, OWNER)); await writeFile(path.join(root, OWNER), 'file');
    await assert.rejects(acquireProfile(root, OWNER), /real directory/);
});
test('symlinked root and ancestor paths are rejected', async t => {
    const root = await fixture(t); await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, 'link'));
    for (const entry of [path.join(root, 'link'), path.join(root, 'link', 'nested')]) await assert.rejects(acquireProfile(entry, OWNER), /symlinks/);
});
test('relative profile roots are rejected', async () => { await assert.rejects(acquireProfile('profiles', OWNER), /absolute/); });
test('different owners receive different empty directories', async t => {
    const root = await fixture(t), first = await acquireProfile(root, OWNER);
    await assert.rejects(acquireProfile(root, '222222222222222222'), e => e.code === 'EEXIST');
    await first.release();
    const second = await acquireProfile(root, '222222222222222222');
    assert.notEqual(first.directory, second.directory); await first.release(); await second.release();
});

test('failed per-profile acquisition rolls back its newly acquired global lease', async t => {
    const root = await fixture(t), directory = path.join(root, OWNER);
    await mkdir(directory); await writeFile(path.join(directory, '.theatrebot-lease'), 'existing lease');
    await assert.rejects(acquireProfile(root, OWNER), e => e.code === 'EEXIST');
    const next = await acquireProfile(root, '222222222222222222'); await next.release();
    assert.equal(await readFile(path.join(directory, '.theatrebot-lease'), 'utf8'), 'existing lease');
});

test('profiles cannot be configured inside the build context or at shared filesystem roots', async () => {
    await assert.rejects(acquireProfile(process.cwd() + '/profiles', OWNER), /outside the application/);
    await assert.rejects(acquireProfile('/', OWNER), /dedicated private directory/);
});
