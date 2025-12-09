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

- Node.js 18+
- Chrome/Chromium
- FFmpeg
- Docker/Podman (for production with Xvfb)

### Installation

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env with your Discord token
```

### Discord Token

You need a Discord **user token** (not a bot token). See the [StreamBot wiki](https://github.com/ysdragon/StreamBot/wiki/Get-Discord-user-token) for instructions.

> ⚠️ **Warning**: Self-bots violate Discord ToS. Use a dedicated account.

### Running

```bash
# Development
npm run start

# With Node.js
npm run build
npm run start:node
```

## Usage

1. Configure your Discord token in `.env`
2. Start the bot with `npm run start`
3. Use Discord commands to join a voice channel
4. Control the browser via the web UI at `http://localhost:8080`

## RBAC Permissions

| Level      | Capabilities                                                       |
| ---------- | ------------------------------------------------------------------ |
| `join`     | Request bot to join your call, control sessions you started        |
| `control`  | Use remote navigation + presets on any session you're connected to |
| `navigate` | Update the URL to any page instead of presets                      |
| `admin`    | Configure permissions via slash commands                           |

Server owners and administrators automatically have `admin` permissions.

## Container Deployment (Required)

> ⚠️ **Note**: This bot requires Linux with Xvfb and PulseAudio. Running directly with `bun` on macOS/Windows won't work.

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
