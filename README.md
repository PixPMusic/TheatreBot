# Theatre Bot

A Discord self-bot that streams browser content to voice channels, controllable via a remote web UI.

Very early alpha. Latency is high and the UI is not very user-friendly.

> [!CAUTION]
> Using any kind of automation programs on your account can result in your account getting permanently banned by Discord. Use at your own risk

## Features

- 📺 **Live Browser Streaming** - Stream browser content to Discord voice channels
- 🎮 **Remote Control** - TV-remote style web UI for navigation
- 🔗 **Smart Presets** - Quick access to YouTube and Plex with context-aware search
- 🔐 **RBAC** - Discord role-based stream access
- 👤 **Personal browsers** - Mandatory Discord OAuth claims and persistent, isolated profiles per Discord user

## Setup

### Prerequisites

- Node.js 22.4.0 or newer (required by discord-video-stream v7)
- Linux with X11/Xvfb and PulseAudio for browser screen/audio capture
- Chrome/Chromium and a matching ChromeDriver
- FFmpeg with `x11grab`, `pulse`, `libx264`, `libopus`, and the `azmq` filter (`libzmq` enabled); stable H265/VP8 also need `libx265`/`libvpx`
- Docker/Podman for the bundled Linux deployment

### Installation

```bash
# Install locked dependencies, including native install scripts
npm ci

# Copy environment config
cp .env.example .env

# Edit .env with your Discord token and required OAuth application credentials
```

The v7 streaming library uses the `@lng2004/discord.js-selfbot-v13` client and native WebRTC/DAVE and FFmpeg dependencies. Allow dependency install scripts, including `node-av`, `@lng2004/node-datachannel`, and `zeromq`, in package managers that require approval. Installation needs access to native binary downloads; if a prebuilt binary is unavailable for your platform, follow that package's source-build prerequisites. Do not use `--ignore-scripts`.

The container downloads the [BtbN FFmpeg build](https://github.com/BtbN/FFmpeg-Builds) with `libzmq`. If using your own FFmpeg, check `ffmpeg -filters` for `azmq`. Set `FFMPEG_PATH` to override the executable used for both capture and stable transcoding.

### Discord Token

You need a Discord **user token** (not a bot token). See the [StreamBot wiki](https://github.com/ysdragon/StreamBot/wiki/Get-Discord-user-token) for instructions.

> ⚠️ **Warning**: Self-bots violate Discord ToS. Use a dedicated account.

### Running

```bash
# Compile TypeScript and run
npm run build
npm start

# Verify the migration contracts and stop/restart lifecycle
npm test
```

## Usage

1. Configure your Discord token, required [Discord OAuth login](docs/DISCORD_OAUTH.md), and guild join grants in `.env`.
2. Start the bot with `npm run start`. Missing OAuth configuration or `SERVER_ENABLED=false` fails before Discord login.
3. Join a voice channel and send `!join` (or `!stable`). The reply contains a five-minute claim link; no browser, voice connection, or capture starts yet.
4. Open that link, sign in as the Discord user who requested the stream, read the screen visibility notice, and choose **Start my browser and stream**. Stay in the same voice channel with current join permission.
5. Use the remote controls or owner-only `!url`. Your browser screen is visible to channel watchers.

### Discord Commands

| Command | Behavior |
| ------- | -------- |
| `!join` | Request a login/claim link for default capture: one H264 encode plus real browser audio encoded as Opus in NUT; v7 handles demuxing, WebRTC packetization, and DAVE. |
| `!beta` | Alias for `!join`, retained for existing commands. |
| `!stable` | Request a login/claim link for the older capture path: MPEG-2/PCM Matroska, then v7 transcodes to the configured video codec and Opus in NUT. |
| `!leave` | Cancel a pending claim or stop capture, close the browser and leave voice. Profile data persists. |
| `!url <url>` / `!goto <url>` | The current owner may navigate their streaming browser while still entitled to join. |
| `!help` | Show command help. |

Both modes use v7 Go Live playback with stream previews disabled. The default `!join` mode (and its `!beta` alias) always uses H264; the configured dimensions, frame rate, bitrates, and H26x preset still apply. Use `!stable` for the older transcoding path, including configured H265/VP8 output. Use `!leave` before switching modes. The bot stops when the owner leaves the requested voice channel, and automatically leaves an empty channel. Competing users or modes cannot start another stream. Leaving, expiration and restart invalidate claim links; logging in or opening a link alone never starts a stream.

## RBAC Permissions

Discord commands use an optional JSON permissions file. Without a configured file, only server owners and members with Discord Administrator permission can request and stop streams. Help remains public. Grants are scoped to the server; stopping requires membership in the active stream's voice channel, including for administrators. Only the OAuth-verified requester owns the browser. Admins and users with control grants can stop it with `!leave` but cannot read its URL/preset/session metadata or operate another user's profile.

| Level | Capabilities |
| ----- | ------------ |
| `join` | Request and claim streams; fully operate, navigate and stop your own browser while entitled to join. |
| `control` | Stop the active session with `!leave`. |
| `navigate` | Legacy policy field retained for compatibility; does not grant access to another owner's browser. |
| `admin` | Request streams and stop active streams in the same voice channel; does not share personal browsers. |

Copy `permissions.example.json` to `permissions.json`, replace its example guild ID with your server ID, and add role or user IDs to the appropriate arrays. Discord Developer Mode exposes **Copy ID** for servers, roles, and users. Set `PERMISSIONS_FILE=./permissions.json` in `.env`, then restart the bot. IDs must be strings, and each guild entry accepts only `join`, `control`, `navigate`, and `admin` arrays; omitted levels have no grants. A configured file that cannot be read or contains invalid JSON/schema prevents startup with an actionable error. There is no `/permissions` slash command.

For a container, the path must exist inside the container. Set `PERMISSIONS_FILE=/app/permissions.json` in `.env` and add a read-only mount under the `theatre-bot` service in `compose.yaml`:

```yaml
volumes:
  - ./permissions.json:/app/permissions.json:ro
```

With a manual container launch, pass `-v "$PWD/permissions.json:/app/permissions.json:ro"` alongside `--env-file .env`. On SELinux hosts, use `:ro,Z` for the mount label. Restart after changing permissions.

## Container Deployment

> ⚠️ **Note**: Browser capture requires Linux with X11/Xvfb and PulseAudio. Use the container on macOS/Windows. Native dependency installation and live Discord streaming must be verified on the target platform.

### With Podman/Docker Compose

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your Discord token and required OAuth application credentials

# Build and run
podman-compose up -d
# or
docker compose up -d
```

### Manual Container Build

```bash
# Build
podman build -t theatre-bot .

# Run
podman run -d \
  --name theatre-bot \
  --env-file .env \
  --shm-size=2gb \
  -v theatrebot-browser-profiles:/var/lib/theatrebot/profiles \
  -p 127.0.0.1:8080:8080 \
  theatre-bot
```

## License

MIT

## Web control access

The web UI and Discord OAuth are required for every stream. Claims force fresh guild role verification through the existing Discord client, with only OAuth `identify` requested. Browser controls and metadata require the exact profile owner, current voice membership and current `join` permission. Owners may use full navigation, keys, search, presets, back and refresh. There is no profile sharing.

Native HTTP listening and Compose port publishing default to loopback. For remote access, put the web UI behind an HTTPS reverse proxy and set the exact public callback in `DISCORD_REDIRECT_URI`; `SERVER_HOST=0.0.0.0` selects the container's listening interface. The supplied Compose file keeps host publishing on loopback.

Explicit browser URLs accept HTTP(S), including private Plex addresses, and reject local files, executable/browser-internal schemes, and embedded credentials. This is a URL policy for a trusted media browser, not isolation from private HTTP services. OAuth sessions last at most eight hours and are cleared on restart/logout. OAuth proves the web user’s identity. The existing Discord connection fetches that user’s guild roles, sharing verified roles for at most 30 seconds across browser logins; voice/session checks run on every action. If Discord verification is delayed, controls stay disabled and retry automatically without extending expired role permissions.

## Persistent browser profiles

`BROWSER_PROFILE_ROOT` is an absolute, dedicated directory outside the application and Docker build context. The default is `/var/lib/theatrebot/profiles`; Compose mounts its named `browser-profiles` volume there. Native Linux operators should create a private directory owned by the bot's OS user and set that path. macOS and Windows hosts must run the Linux container: ownership and process exit verification use Linux `/proc` and are checked before Discord login.

Each validated Discord user ID selects its own `--user-data-dir`, with root and owner directories restricted to mode `0700`. Cookies, login sessions, localStorage, IndexedDB and service workers remain after normal `!leave` and graceful restarts. Existing shared Chrome profiles are never copied. Profiles are private from other bot users; the operator who owns the machine and storage can access them.

Only one browser lease exists across the profile root. Teardown stops and waits for capture, invalidates browser controls, closes Selenium once, and verifies the owned Chrome/ChromeDriver processes exit before releasing the reservation. Failed quit falls back to those owned process identities; it never kills browsers by name. Incomplete cleanup blocks replacement and retains ownership for an authorized `!leave` retry.

After an abrupt supervisor/container crash, lease files may remain and startup fails closed. An operator must establish that the old bot, owned browser/driver and capture processes are gone before removing the root `.theatrebot-browser-lease` and that owner's `.theatrebot-lease` files. Keep all profile data. The bot does not automatically guess that a lease is stale or provide a profile reset UI.

`npm test` covers claim ownership, CSRF/origin checks, replay/cancellation, current membership, startup/teardown races, owner-only controls, private paths and exclusive leases. `test/integration/profile-isolation.mjs` is a separate disposable Linux/Xvfb/PulseAudio fixture for actual Chromium cookie/site-storage isolation, persistence, process/window/audio exit and hung-navigation cancellation. It must not run in the live bot container.
