# YouTube TV SponsorBlock companion

Optional unpacked Manifest V3 extension for `https://www.youtube.com/tv` watch
routes (`#/watch?v=…`). It automatically skips only community-reported **sponsor**
segments using [SponsorBlock](https://sponsor.ajay.app/). The standard SponsorBlock
extension targets YouTube's desktop player; this companion handles the TV
interface's native video and hash navigation.

Mount this directory at a stable absolute container path, for example
`/opt/theatrebot-extensions/tv-sponsorblock`, and include that path in the optional
extension loader's JSON setting:

```dotenv
BROWSER_EXTENSION_PATHS=["/opt/theatrebot-extensions/tv-sponsorblock"]
```

The host source directory can be mounted read-only. The loader stages assets in
the selected browser profile's private cache, so the browser can write extension
state. Restart TheatreBot to load or remove the extension. Its files and parent
extension loader are optional; leaving `BROWSER_EXTENSION_PATHS` empty disables
it. Choose the TV URL through the existing browser controls. This extension does
not select a URL, change the browser's user agent, or modify a saved profile.

It follows hash navigation, attaches to inserted/replaced videos, and rechecks
playback time before seeking. Segments are skipped only while actively playing
with loaded media, no known ad marker, and a finite video duration matching the
submission's `videoDuration` within one second. Unknown/stale duration metadata,
live streams, known ad state, and API failures leave playback unchanged. A reused
video element on a new watch route must load fresh metadata first. These checks
reduce the risk of seeking the same element's advertisement timeline; undocumented
TV player changes and equal-duration ads can still defeat DOM/duration checks.
There is no submission, skip telemetry, settings UI, account integration, or
support for other segment categories.

## Privacy and attribution

For each watch route, the extension requests the first four hexadecimal characters
of the video's SHA-256 hash from `https://sponsor.ajay.app/api/skipSegments/…` and
selects the exact video locally. Requests omit credentials and referrers, reject
redirects, and time out after five seconds. SponsorBlock sees your network IP and
the hash bucket; hashing does not guarantee anonymity. No data is persisted by this
extension, and it sends no viewed-segment reports. Only the SponsorBlock host
permission is granted; the content script runs in an isolated world in the TV
page's top frame.

Uses SponsorBlock data licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) from
https://sponsor.ajay.app/. See the
[API documentation](https://wiki.sponsor.ajay.app/w/API_Docs) and
[attribution template](https://gist.github.com/ajayyy/4b27dfc66e33941a45aeaadccb51de71).
The extension source is original TheatreBot code covered by the repository's MIT
license. The TV route/native-video approach was informed by
[TizenTube's SponsorBlock feature](https://github.com/reisxd/TizenTube/blob/9dd70a717bdfa5282077004adcd0303069dcd6e5/mods/features/sponsorblock.js);
no TizenTube code was copied.

Run the focused tests with `node --test test/tv-sponsorblock.test.mjs`.
