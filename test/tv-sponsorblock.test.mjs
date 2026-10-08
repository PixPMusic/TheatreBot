import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../extensions/tv-sponsorblock/', import.meta.url);
const background = readFileSync(new URL('background.js', root), 'utf8');
const content = readFileSync(new URL('content.js', root), 'utf8');
const ID = '0e3GPea1Tyg';
const OTHER = 'abcdefghijk';
const route = id => `https://www.youtube.com/tv#/watch?v=${id}`;
const segment = (start = 10, end = 20, duration = 100) => ({start, end, duration});
const apiSegment = overrides => ({segment: [10, 20], category: 'sponsor', actionType: 'skip', videoDuration: 100, ...overrides});

function worker(fetcher) {
  let listener;
  const timers = new Map();
  let serial = 0;
  vm.runInNewContext(background, {URL, TextEncoder, Uint8Array, crypto: webcrypto, AbortController,
    fetch: fetcher, setTimeout: callback => {timers.set(++serial, callback); return serial;},
    clearTimeout: id => timers.delete(id),
    chrome: {runtime: {id: 'own', onMessage: {addListener: callback => {listener = callback;}}}}});
  return {timers, send(message = {type: 'getSponsorSegments', videoID: ID},
    sender = {id: 'own', frameId: 0, url: route(ID)}) {
    let accepted;
    const result = new Promise(resolve => {
      accepted = listener(message, sender, value => resolve(JSON.parse(JSON.stringify(value))));
      if (!accepted) resolve(null);
    });
    return {accepted, result};
  }};
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({type}); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
class Video extends Target {
  paused = false; seeking = false; readyState = 4; duration = 100; playbackRate = 1;
  seeks = []; time = 0;
  get currentTime() { return this.time; }
  set currentTime(value) { this.seeks.push(value); this.time = value; }
}
function page(initial = route(ID), initialVideo = new Video()) {
  const window = new Target(); window.top = window;
  const location = {href: initial};
  const timers = new Map(); let serial = 0;
  const requests = [];
  let video = initialVideo, ad = false, observer, disconnected = false;
  const document = {documentElement: {}, querySelector: selector => selector === 'video' ? video : ad ? {} : null};
  vm.runInNewContext(content, {window, location, document, URL,
    chrome: {runtime: {sendMessage: message => new Promise((resolve, reject) => requests.push({message, resolve, reject}))}},
    MutationObserver: class {constructor(callback) {observer = callback;} observe() {} disconnect() {disconnected = true;}},
    setTimeout: (callback, delay) => {timers.set(++serial, {callback, delay}); return serial;},
    clearTimeout: id => timers.delete(id)});
  return {window, location, timers, requests, get video() {return video;}, get disconnected() {return disconnected;},
    replace(next) {video = next; observer();}, ad(value) {ad = value; observer();}, mutate() {observer();},
    navigate(value) {location.href = value; window.emit('hashchange');},
    fireTimer() {const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback();},
    resolve(index = requests.length - 1, segments = [segment()]) {requests[index].resolve({segments});}};
}

test('manifest grants only the API host and top-frame exact HTTPS TV paths', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://sponsor.ajay.app/*']);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.youtube.com/tv', 'https://www.youtube.com/tv/*']);
});

test('worker rejects foreign frames, senders, URLs, routes, types and IDs before fetch', async () => {
  let calls = 0;
  const w = worker(() => {calls++; throw Error('unexpected');});
  for (const sender of [{id: 'other'}, {frameId: 1}, {url: 'http://www.youtube.com/tv#/watch?v=' + ID},
    {url: 'https://www.youtube.com.evil.test/tv#/watch?v=' + ID}, {url: 'https://www.youtube.com/watch?v=' + ID},
    {url: route(OTHER)}, {url: 'https://www.youtube.com/tv-other#/watch?v=' + ID},
    {url: 'https://www.youtube.com/tv#https://evil.test/watch?v=' + ID}]) {
    assert.equal(w.send(undefined, {id: 'own', frameId: 0, url: route(ID), ...sender}).accepted, false);
  }
  for (const message of [null, {}, {type: 'fetch', videoID: ID, url: 'http://localhost'},
    {type: 'getSponsorSegments', videoID: 'http://x'}, {type: 'getSponsorSegments', videoID: '../whatever'}])
    assert.equal(w.send(message).accepted, false);
  assert.equal(calls, 0);
});

test('worker hashes ID, fixes endpoint/credentials/redirect policy and selects only exact valid sponsor skips', async () => {
  let request;
  const w = worker(async (url, options) => {
    request = {url, options};
    return {ok: true, status: 200, json: async () => [{videoID: OTHER, segments: [apiSegment({})]},
      {videoID: ID, segments: [apiSegment({}), apiSegment({category: 'intro'}), apiSegment({actionType: 'mute'}),
        apiSegment({segment: [-1, 20]}), apiSegment({segment: [20, 10]}), apiSegment({segment: [0, Infinity]}),
        apiSegment({segment: [0, 20, 30]}), apiSegment({videoDuration: 0}), apiSegment({videoDuration: undefined}),
        apiSegment({segment: [0, 200]})]}]};
  });
  assert.deepEqual(await w.send().result, {segments: [segment()]});
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(ID))).toString('hex');
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://sponsor.ajay.app');
  assert.equal(url.pathname, '/api/skipSegments/' + hash.slice(0, 4));
  assert.equal(url.searchParams.get('categories'), '["sponsor"]');
  assert.equal(url.searchParams.get('actionTypes'), '["skip"]');
  assert.equal(url.searchParams.has('videoID'), false);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(w.timers.size, 0);
});

test('404, HTTP errors, malformed JSON, unknown ID, and aborted timeout return no segments', async () => {
  for (const response of [{status: 404}, {status: 500}, {ok: true, json: async () => {throw Error('json');}},
    {ok: true, json: async () => ({})}, {ok: true, json: async () => [{videoID: OTHER, segments: [apiSegment({})]}]}]) {
    const w = worker(async () => response);
    assert.deepEqual(await w.send().result, {segments: []});
    assert.equal(w.timers.size, 0);
  }
  const w = worker((_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))));
  const request = w.send(); await flush();
  [...w.timers.values()][0]();
  assert.deepEqual(await request.result, {segments: []});
  assert.equal(w.timers.size, 0);
});

test('initial watch route starts without a hash event; duplicate hash keeps one request and one timer', async () => {
  const p = page(); await flush();
  assert.equal(p.requests.length, 1);
  p.resolve(); await flush();
  assert.equal(p.timers.size, 1);
  assert.equal([...p.timers.values()][0].delay, 10000);
  p.window.emit('hashchange');
  assert.equal(p.requests.length, 1); assert.equal(p.timers.size, 1);
  p.video.time = 10; p.fireTimer();
  assert.deepEqual(p.video.seeks, [20]); assert.equal(p.timers.size, 0);
});

test('late A→B→A requests cannot repopulate segments; route-away clears timers and listeners', async () => {
  const p = page(); await flush();
  p.navigate(route(OTHER)); await flush(); p.navigate(route(ID)); await flush();
  p.resolve(0); p.resolve(1); await flush();
  assert.equal(p.timers.size, 0);
  p.resolve(2, [segment(30, 40)]); await flush();
  assert.equal(p.timers.size, 0, 'reused old timeline is not fresh metadata');
  p.video.emit('loadedmetadata'); assert.equal(p.timers.size, 1);
  p.navigate('https://www.youtube.com/tv#/');
  assert.equal(p.timers.size, 0); assert.equal(p.video.count(), 0);
  p.video.time = 35; p.video.emit('timeupdate'); assert.deepEqual(p.video.seeks, []);
});

test('video insertion and replacement detach old listeners, and unload cleans all resources', async () => {
  const p = page(route(ID), null); await flush(); p.resolve(); await flush();
  assert.equal(p.timers.size, 0);
  const first = new Video(); p.replace(first); assert.equal(p.timers.size, 1);
  const second = new Video(); second.time = 12; p.replace(second);
  assert.equal(first.count(), 0); assert.deepEqual(second.seeks, [20]);
  first.time = 12; first.emit('timeupdate'); assert.deepEqual(first.seeks, []);
  p.window.emit('pagehide'); assert.equal(second.count(), 0); assert.equal(p.timers.size, 0);
  assert.equal(p.window.count(), 0); assert.equal(p.disconnected, true);
});

test('paused, seeking, stalled, low readiness and ads block seeking; duration must match', async () => {
  for (const prepare of [v => {v.paused = true;}, v => {v.seeking = true;}, v => {v.readyState = 2;},
    v => {v.duration = 30;}, v => {v.duration = Infinity;}, v => {v.playbackRate = 0;}]) {
    const v = new Video(); v.time = 12; prepare(v);
    const p = page(route(ID), v); await flush(); p.resolve(); await flush();
    assert.deepEqual(v.seeks, []); assert.equal(p.timers.size, 0);
  }
  const p = page(); await flush(); p.resolve(); await flush();
  p.video.emit('waiting'); p.video.time = 12; p.video.emit('timeupdate'); assert.deepEqual(p.video.seeks, []);
  p.ad(true); p.video.emit('playing'); assert.deepEqual(p.video.seeks, []);
  p.ad(false); assert.deepEqual(p.video.seeks, [20]);
  p.video.time = 12; p.video.duration = 100.9; p.video.emit('durationchange'); assert.deepEqual(p.video.seeks, [20, 20]);
  p.video.time = 12; p.video.duration = 101.1; p.video.emit('durationchange'); assert.equal(p.video.seeks.length, 2);
});

test('timers recheck actual time and rate; pause cancels, seeking into/back into overlap skips once', async () => {
  const p = page(); await flush(); p.resolve(0, [segment(10, 20), segment(18, 30), segment(90, 110)]); await flush();
  p.fireTimer(); assert.deepEqual(p.video.seeks, [], 'wall-clock expiry with stalled media does not seek');
  p.video.playbackRate = 2; p.video.emit('ratechange'); assert.equal([...p.timers.values()][0].delay, 5000);
  p.video.paused = true; p.video.emit('pause'); assert.equal(p.timers.size, 0);
  p.video.time = 15; p.video.paused = false; p.video.emit('play'); assert.deepEqual(p.video.seeks, [30]);
  p.video.emit('timeupdate'); assert.deepEqual(p.video.seeks, [30]);
  p.video.time = 19; p.video.seeking = true; p.video.emit('seeking'); assert.equal(p.video.seeks.length, 1);
  p.video.seeking = false; p.video.emit('seeked'); assert.deepEqual(p.video.seeks, [30, 30]);
  p.video.time = 95; p.video.emit('timeupdate'); assert.equal(p.video.seeks.length, 2, 'out-of-duration interval ignored');
});

test('extension reload message rejection and non-watch routes leave playback alone', async () => {
  const p = page(); await flush(); p.requests[0].reject(Error('Extension context invalidated')); await flush();
  assert.equal(p.timers.size, 0); assert.deepEqual(p.video.seeks, []);
  for (const url of ['https://www.youtube.com/watch?v=' + ID, 'https://www.youtube.com/tv#/search?v=' + ID,
    'https://www.youtube.com/tv#/watch?v=short', 'https://www.youtube.com/tv-other#/watch?v=' + ID]) {
    const q = page(url); await flush(); assert.equal(q.requests.length, 0); assert.equal(q.video.count(), 0);
  }
});

test('a refused seek does not loop and fresh media must load metadata before resuming', async () => {
  class RefusingVideo extends Video {
    get currentTime() {return this.time;}
    set currentTime(value) {this.seeks.push(value);}
  }
  const v = new RefusingVideo(); v.time = 12;
  const p = page(route(ID), v); await flush(); p.resolve(); await flush();
  v.emit('timeupdate'); v.emit('timeupdate');
  assert.deepEqual(v.seeks, [20]);
  v.time = 25; v.emit('timeupdate'); v.time = 12; v.emit('seeked');
  assert.deepEqual(v.seeks, [20, 20]);
  v.time = 25; v.emit('timeupdate'); v.emit('loadstart');
  v.time = 12; v.emit('canplay'); assert.equal(v.seeks.length, 2);
  v.emit('loadedmetadata'); assert.equal(v.seeks.length, 3);
});
