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

test('startup preparation creates a missing private root without creating profiles or leases', async t => {
    const { prepareProfileRoot } = await import('../dist/browser/profiles.js');
    const { readdir } = await import('node:fs/promises');
    const parent = await fixture(t), root = path.join(parent, 'missing', 'profiles');
    assert.equal(await prepareProfileRoot(root), root);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(root), []);
});

test('preparation preserves existing profile data and exclusive lease files while cleaning its probe', async t => {
    const { prepareProfileRoot } = await import('../dist/browser/profiles.js');
    const { readdir } = await import('node:fs/promises');
    const root = await fixture(t), lease = await acquireProfile(root, OWNER);
    await writeFile(path.join(lease.directory, 'site-data'), 'keep');
    const rootLease = await readFile(path.join(root, '.theatrebot-browser-lease'), 'utf8');
    const ownerLease = await readFile(path.join(lease.directory, '.theatrebot-lease'), 'utf8');
    await prepareProfileRoot(root);
    assert.equal(await readFile(path.join(lease.directory, 'site-data'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(root, '.theatrebot-browser-lease'), 'utf8'), rootLease);
    assert.equal(await readFile(path.join(lease.directory, '.theatrebot-lease'), 'utf8'), ownerLease);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.theatrebot-write-probe-')), []);
    await lease.release();
});

test('read-only probe failure produces an actionable startup error and leaves no probe', async t => {
    const { prepareProfileRoot } = await import('../dist/browser/profiles.js');
    const fs = (await import('node:fs/promises')).default;
    const root = await fixture(t);
    t.mock.method(fs, 'open', async () => { throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }); });
    await assert.rejects(prepareProfileRoot(root), error => /BROWSER_PROFILE_ROOT/.test(error.message) && /read-only/.test(error.message) && /writable persistent storage/.test(error.message));
    assert.deepEqual(await fs.readdir(root), []);
});

test('a failed probe write closes its handle and removes only its own temporary file', async t => {
    const { prepareProfileRoot } = await import('../dist/browser/profiles.js');
    const fs = (await import('node:fs/promises')).default;
    const root = await fixture(t), originalOpen = fs.open.bind(fs);
    await writeFile(path.join(root, 'existing-data'), 'keep');
    let opened;
    t.mock.method(fs, 'open', async (...args) => {
        opened = await originalOpen(...args);
        t.mock.method(opened, 'writeFile', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
        return opened;
    });
    await assert.rejects(prepareProfileRoot(root), /BROWSER_PROFILE_ROOT.*disk full/);
    assert.equal(opened.fd, -1);
    assert.deepEqual(await fs.readdir(root), ['existing-data']);
    assert.equal(await readFile(path.join(root, 'existing-data'), 'utf8'), 'keep');
});

for (const ancestor of [false, true]) test(`startup preparation rejects a symlinked ${ancestor ? 'ancestor' : 'root'} before any probe`, async t => {
    const { prepareProfileRoot } = await import('../dist/browser/profiles.js');
    const { readdir } = await import('node:fs/promises');
    const root = await fixture(t); await mkdir(path.join(root, 'target')); await symlink(path.join(root, 'target'), path.join(root, 'alias'));
    await assert.rejects(prepareProfileRoot(path.join(root, 'alias', ...(ancestor ? ['profiles'] : []))), /BROWSER_PROFILE_ROOT.*symlinks/);
    assert.deepEqual(await readdir(path.join(root, 'target')), []);
});
