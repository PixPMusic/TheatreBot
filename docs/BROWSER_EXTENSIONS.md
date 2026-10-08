# Optional browser extensions

Extensions are disabled by default. An operator can opt into local unpacked
Manifest V3 extensions with `BROWSER_EXTENSION_PATHS`, a JSON array of absolute
directories inside the runtime. TheatreBot never downloads extension assets at
startup, and viewers cannot change the extension list through the remote controls.
An invalid list, unreadable manifest, MV2 manifest, or incompatible browser
prevents startup before Discord login.

Use the bundled Fedora **Chromium**, or Chrome for Testing with a matching
ChromeDriver. Branded Google Chrome removed the unpacked-extension command-line
switches and is rejected when extensions are enabled. Keep the browser current;
this feature does not restore MV2 or require a browser downgrade.

## Fetch pinned official assets

The following releases were inspected and tested with Fedora Chromium
154.0.8037.92. Both Chromium archives contain Manifest V3 extensions. **uBlock
Origin Lite** is the optional MV3 product; it is distinct from full uBlock Origin.
Consult its [current documentation](https://github.com/uBlockOrigin/uBOL-home)
for filtering modes, permissions, and features.

| Extension | Official release / asset | SHA256 |
| --- | --- | --- |
| SponsorBlock | [5.7](https://github.com/ajayyy/SponsorBlock/releases/tag/5.7), `ChromeExtension.zip` | `393f3d7e0768c917d9cb5d6fe393180101fcbf829b61ec6965350df1ce1cdfac` |
| uBlock Origin Lite | [2026.1006.1931](https://github.com/uBlockOrigin/uBOL-home/releases/tag/2026.1006.1931), `uBOLite_2026.1006.1931.chromium.zip` | `1670f92590f5ad5b20f02d0a75e144572567b4ba979b3dc3204c41f651206fe7` |

Install GitHub CLI and `unzip` on the operator host. These commands discover the
named assets from their official releases through GitHub, verify the archives,
then unpack them into private, ignored directories:

```sh
mkdir -p extension-downloads extensions-assets/sponsorblock extensions-assets/ubol
gh release download 5.7 --repo ajayyy/SponsorBlock \
  --pattern ChromeExtension.zip --dir extension-downloads
gh release download 2026.1006.1931 --repo uBlockOrigin/uBOL-home \
  --pattern uBOLite_2026.1006.1931.chromium.zip --dir extension-downloads
python3 - <<'PY'
from hashlib import sha256
from pathlib import Path
expected = {
    'ChromeExtension.zip': '393f3d7e0768c917d9cb5d6fe393180101fcbf829b61ec6965350df1ce1cdfac',
    'uBOLite_2026.1006.1931.chromium.zip': '1670f92590f5ad5b20f02d0a75e144572567b4ba979b3dc3204c41f651206fe7',
}
for name, digest in expected.items():
    if sha256((Path('extension-downloads') / name).read_bytes()).hexdigest() != digest:
        raise SystemExit(f'Hash mismatch: {name}; do not unpack')
print('Both archive hashes verified')
PY
# Run these only after the verification succeeds.
unzip extension-downloads/ChromeExtension.zip -d extensions-assets/sponsorblock
unzip extension-downloads/uBOLite_2026.1006.1931.chromium.zip -d extensions-assets/ubol
```

Review the unpacked `manifest.json` and upstream licenses before enabling.
SponsorBlock 5.7 declares `storage` and `scripting`, with YouTube and its API as
required hosts and optional additional hosts. uBOL 2026.1006.1931 declares
`activeTab`, `alarms`, `declarativeNetRequest`, `offscreen`, `scripting`, `storage`,
`unlimitedStorage`, `userScripts`, and `<all_urls>` access. These are trusted
browser code with access to the streaming profile. The loader checks manifest
shape and MV3, not whether extension code is safe.

## Container setup

Add the read-only asset mount alongside the existing profile volume under the
`theatre-bot` service in `compose.yaml`:

```yaml
volumes:
  - browser-profiles:/var/lib/theatrebot/profiles
  - ./extensions-assets:/opt/theatrebot-extensions:ro
```

On SELinux hosts, use `:ro,Z`. Set this in `.env` and restart:

```dotenv
BROWSER_EXTENSION_PATHS=["/opt/theatrebot-extensions/sponsorblock","/opt/theatrebot-extensions/ubol"]
```

Select only SponsorBlock by omitting the second directory. Clear the variable or
set `BROWSER_EXTENSION_PATHS=[]` to return to disabled extensions. Paths must be
absolute and cannot contain commas or control characters. Symlinks and `..`
are resolved to canonical paths; duplicate directories are rejected. Paths are
operator configuration, not a filesystem sandbox. Asset contents must be regular
files and directories; nested symlinks are rejected during staging.

Extension settings live in the selected Chrome profile. Mounted originals remain
read-only. TheatreBot stages a private writable copy under that profile's
`.theatrebot-extensions` directory because Chromium must write indexed static
filter rules inside unpacked extensions. Chrome writes extension storage into
its writable profile. The persistent profile volume in bundled Compose retains
settings across container restarts. Each profile has independent extension
settings; TheatreBot does not synchronize them.

The bot launches in kiosk mode. For first-run onboarding or a permissions change,
stop the bot and open the same Chromium/profile with the same staged extension switches
without `--kiosk`/`--start-fullscreen`. Profiles are normally at
`/var/lib/theatrebot/profiles/<your Discord user ID>`; `BROWSER_PROFILE_ROOT` can
change that root. Use the `.theatrebot-extensions/<source-path hash>` directories
from the last launch for both `--load-extension` and `--disable-extensions-except`,
with the profile directory passed as `--user-data-dir`. Visit `chrome://extensions` or each
extension's options page, complete SponsorBlock onboarding and configure uBOL's
filtering mode/site permissions, then quit Chromium before restarting the bot.
Never run two browsers against the same profile. The web remote does not expose
browser-internal pages or extension installation.

Neither pinned archive includes a manifest `key`. Keep each absolute runtime
source asset path and profile path stable across updates so the staged path,
Chromium's unpacked extension ID, and its
profile storage remain stable. Preserve any manifest key supplied by future
upstream releases; do not invent or strip one.

## Updates and playback limitations

Updates are explicit: stop the bot, fetch a chosen official release to a fresh
staging directory, record and verify its SHA256, inspect its manifest/version and
permissions, replace the asset directory at its existing path, then restart and
check the loaded versions. Do not unzip newer files over old files: stale files
can remain. Keep a verified previous archive for rollback. Profiles, extension
assets, downloads, and caches are excluded from the image build context and Git
when using the directory names above; keep any differently named private
directories outside the repository/build context.

SponsorBlock installation alone does not prove sponsor skipping on
`youtube.com/tv`. Its [YouTube TV support issue](https://github.com/ajayyy/SponsorBlock/issues/213)
remains open. Desktop YouTube and TV playback need separate checks using a video
with known SponsorBlock segments. The default TV URL and TV user agent remain
operator choices. Ad blocking also varies by site and filtering mode; installing
uBOL does not guarantee every video advertisement is blocked.
