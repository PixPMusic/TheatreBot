/* Original TheatreBot code, MIT. SponsorBlock data: https://sponsor.ajay.app/ */
(() => {
  'use strict';
  if (window.top !== window) return;
  const events = ['play', 'playing', 'canplay', 'pause', 'timeupdate', 'seeking', 'seeked',
    'ratechange', 'loadedmetadata', 'durationchange', 'waiting', 'stalled', 'emptied', 'loadstart'];
  let activeID = null;
  let generation = 0;
  let segments = [];
  let video = null;
  let timer = null;
  let stalled = false;
  let timelineReady = true;
  let lastSkip = null;
  let skipping = false;
  let stopped = false;

  function watchVideoID() {
    try {
      const url = new URL(location.href);
      if (url.origin !== 'https://www.youtube.com' ||
          (url.pathname !== '/tv' && !url.pathname.startsWith('/tv/'))) return null;
      const route = new URL(url.hash.slice(1), url.origin);
      if (route.origin !== url.origin || route.pathname !== '/watch') return null;
      const id = route.searchParams.get('v');
      return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? id : null;
    } catch {
      return null;
    }
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function attachVideo() {
    const next = activeID ? document.querySelector('video') : null;
    if (next === video) return;
    clearTimer();
    if (video) for (const event of events) video.removeEventListener(event, onVideoEvent);
    video = next;
    stalled = false;
    timelineReady = true;
    lastSkip = null;
    if (video) for (const event of events) video.addEventListener(event, onVideoEvent);
  }

  function onVideoEvent(event) {
    if (event.type === 'waiting' || event.type === 'stalled') stalled = true;
    if (event.type === 'playing' || event.type === 'canplay') stalled = false;
    if (event.type === 'emptied' || event.type === 'loadstart') timelineReady = false;
    if (event.type === 'loadedmetadata') timelineReady = true;
    schedule();
  }

  function schedule() {
    clearTimer();
    if (stopped || skipping) return;
    // Recheck at every event and timer callback: navigation and stalled playback
    // must never let a previously scheduled wall-clock timeout seek another timeline.
    if (watchVideoID() !== activeID) { updateRoute(); return; }
    attachVideo();
    if (!activeID || !video || !timelineReady || stalled || video.paused || video.seeking ||
        video.readyState < 3 || !Number.isFinite(video.duration) || video.duration <= 0 ||
        !Number.isFinite(video.playbackRate) || video.playbackRate <= 0 ||
        document.querySelector('.ad-showing, .ad-interrupting, [data-ad-state="playing"]')) return;
    const now = video.currentTime;
    if (!Number.isFinite(now)) return;
    const intervals = [];
    for (const segment of segments.filter(item => Math.abs(item.duration - video.duration) <= 1 &&
      item.end <= video.duration).sort((a, b) => a.start - b.start)) {
      const previous = intervals.at(-1);
      if (previous && segment.start <= previous.end) previous.end = Math.max(previous.end, segment.end);
      else intervals.push({start: segment.start, end: segment.end});
    }
    if (lastSkip && (now < lastSkip.start || now >= lastSkip.end)) lastSkip = null;
    const next = intervals.find(item => item.end > now);
    if (!next) return;
    if (now >= next.start) {
      // If the player rejects/clamps a seek, do not hammer it on every timeupdate.
      if (lastSkip?.start === next.start && lastSkip.end === next.end) return;
      lastSkip = next;
      skipping = true;
      try { video.currentTime = next.end; } catch { /* Player remains in control. */ }
      finally { skipping = false; }
      if (video.currentTime >= next.end) lastSkip = null;
      return;
    }
    timer = setTimeout(schedule, Math.min(60000, Math.max(10, (next.start - now) * 1000 / video.playbackRate)));
  }

  function updateRoute() {
    if (stopped) return;
    const next = watchVideoID();
    if (next === activeID) { schedule(); return; }
    const hadVideo = video;
    activeID = next;
    const requestGeneration = ++generation;
    segments = [];
    lastSkip = null;
    clearTimer();
    attachVideo();
    // A TV SPA can reuse its video element. Wait for fresh metadata on a changed
    // watch route; the old video's duration alone is not proof of the new timeline.
    if (hadVideo && video === hadVideo) timelineReady = false;
    if (!activeID) return;
    Promise.resolve().then(() => chrome.runtime.sendMessage({type: 'getSponsorSegments', videoID: next}))
      .then(response => {
        if (stopped || requestGeneration !== generation || watchVideoID() !== next) return;
        segments = Array.isArray(response?.segments) ? response.segments : [];
        schedule();
      }).catch(() => { /* Network/extension reload failure leaves playback unchanged. */ });
    schedule();
  }

  const observer = new MutationObserver(() => {
    if (stopped) return;
    if (watchVideoID() !== activeID) updateRoute();
    else schedule();
  });
  observer.observe(document.documentElement, {childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'data-ad-state']});
  function stop() {
    stopped = true;
    generation++;
    clearTimer();
    observer.disconnect();
    if (video) for (const event of events) video.removeEventListener(event, onVideoEvent);
    window.removeEventListener('hashchange', updateRoute);
    window.removeEventListener('popstate', updateRoute);
    window.removeEventListener('pagehide', stop);
  }
  window.addEventListener('hashchange', updateRoute);
  window.addEventListener('popstate', updateRoute);
  window.addEventListener('pagehide', stop);
  updateRoute();
})();
