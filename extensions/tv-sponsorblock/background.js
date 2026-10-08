/* Original TheatreBot code, MIT. SponsorBlock data: https://sponsor.ajay.app/ */
'use strict';

function watchVideoID(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.youtube.com' ||
        (url.pathname !== '/tv' && !url.pathname.startsWith('/tv/'))) return null;
    const route = new URL(url.hash.slice(1), 'https://www.youtube.com');
    if (route.origin !== url.origin || route.pathname !== '/watch') return null;
    const id = route.searchParams.get('v');
    return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}

async function getSponsorSegments(videoID) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(videoID));
  const prefix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0'))
    .join('').slice(0, 4);
  const url = new URL(`https://sponsor.ajay.app/api/skipSegments/${prefix}`);
  url.searchParams.set('categories', '["sponsor"]');
  url.searchParams.set('actionTypes', '["skip"]');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url.href, {
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (response.status === 404) return [];
    if (!response.ok) return [];
    const bucket = await response.json();
    if (!Array.isArray(bucket)) return [];
    const entry = bucket.find(item => item?.videoID === videoID);
    if (!Array.isArray(entry?.segments)) return [];
    return entry.segments.filter(item =>
      item?.category === 'sponsor' && item.actionType === 'skip' &&
      Array.isArray(item.segment) && item.segment.length === 2 &&
      item.segment.every(Number.isFinite) && item.segment[0] >= 0 &&
      item.segment[1] > item.segment[0] &&
      Number.isFinite(item.videoDuration) && item.videoDuration > 0 &&
      item.segment[1] <= item.videoDuration + 1
    ).map(item => ({start: item.segment[0], end: item.segment[1], duration: item.videoDuration}));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      message?.type !== 'getSponsorSegments' ||
      !/^[A-Za-z0-9_-]{11}$/.test(message.videoID ?? '') ||
      watchVideoID(sender.url) !== message.videoID) return false;
  getSponsorSegments(message.videoID).then(segments => respond({segments})).catch(() => respond({segments: []}));
  return true;
});
