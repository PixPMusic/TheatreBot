# Theatre Bot

A Discord self-bot that streams browser content to voice channels, controllable via a remote web UI.

Very early alpha. Latency is high and the UI is not very user-friendly.

> [!CAUTION]
> Using any kind of automation programs on your account can result in your account getting permanently banned by Discord. Use at your own risk

## Features

- 📺 **Live Browser Streaming** - Stream browser content to Discord voice channels
- 🎮 **Remote Control** - TV-remote style web UI for navigation
- 🔗 **Smart Presets** - Quick access to YouTube and Plex with context-aware search
- 🔐 **RBAC** - Discord role-based access control

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

# Edit .env with your Discord token
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

1. Configure your Discord token in `.env`
2. Start the bot with `npm run start`
3. Use Discord commands to join a voice channel
4. Control the browser via the web UI at `http://localhost:8080`

### Discord Commands

| Command | Behavior |
| ------- | -------- |
| `!join` | Default capture: one H264 encode plus real browser audio encoded as Opus in NUT; v7 handles demuxing, WebRTC packetization, and DAVE. |
| `!beta` | Alias for `!join`, retained for existing commands. |
| `!stable` | Older capture path: MPEG-2/PCM Matroska, then v7 transcodes to the configured video codec and Opus in NUT. |
| `!leave` | Stop capture/playback and leave the voice channel. |
| `!url <url>` / `!goto <url>` | Navigate the streaming browser. |
| `!help` | Show command help. |

Both modes use v7 Go Live playback with stream previews disabled. The default `!join` mode (and its `!beta` alias) always uses H264; the configured dimensions, frame rate, bitrates, and H26x preset still apply. Use `!stable` for the older transcoding path, including configured H265/VP8 output. Use `!leave` before switching modes. The bot automatically leaves an empty channel.

## RBAC Permissions

Discord commands use an optional JSON permissions file. Without a configured file, only server owners and members with Discord Administrator permission can start, stop, or navigate streams. Help remains public. Grants are scoped to the server; stopping or navigating also requires membership in the active stream's voice channel, including for administrators.

| Level | Capabilities |
| ----- | ------------ |
| `join` | Start streams with `!join`, `!beta`, or `!stable`; stop sessions you started while you still have join permission. |
| `control` | Stop the active session with `!leave`. |
| `navigate` | Change the URL with `!url` or `!goto`. |
| `admin` | Use all three capabilities within the same server and active voice channel. |

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
# Edit .env with your Discord token

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
  -p 8080:8080 \
  theatre-bot
```

## License

MIT
