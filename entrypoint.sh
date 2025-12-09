#!/bin/bash
set -e

# Strip quotes from env vars if present
STREAM_WIDTH="${STREAM_WIDTH//\"/}"
STREAM_HEIGHT="${STREAM_HEIGHT//\"/}"
DISPLAY="${DISPLAY//\"/}"

# Use defaults
STREAM_WIDTH="${STREAM_WIDTH:-1280}"
STREAM_HEIGHT="${STREAM_HEIGHT:-720}"
DISPLAY="${DISPLAY:-:99}"

# Start D-Bus
mkdir -p /run/dbus
dbus-daemon --system --fork 2>/dev/null || true

# Start PulseAudio in system mode with anonymous auth on a specific socket
# This bypasses the "Access denied" issues for root user in Docker
pulseaudio -D --system --disallow-exit --disallow-module-loading=0 --exit-idle-time=-1 -L "module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulseaudio.socket"

# Set PulseAudio server environment variable for all clients (pactl, ffmpeg, chrome)
export PULSE_SERVER=unix:/tmp/pulseaudio.socket

# Wait for PulseAudio to be ready
echo "Waiting for PulseAudio..."
for i in {1..10}; do
    if pactl info >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Load null sink to capture audio from
pactl load-module module-null-sink sink_name=SpeakerOutput sink_properties=device.description="Speaker_Output"
pactl set-default-sink SpeakerOutput
pactl set-default-source SpeakerOutput.monitor

# Start Xvfb with proper syntax
Xvfb ${DISPLAY} -screen 0 ${STREAM_WIDTH}x${STREAM_HEIGHT}x24 &
sleep 2

echo "==================================="
echo "Theatre Bot Starting..."
echo "Display: ${DISPLAY}"
echo "Resolution: ${STREAM_WIDTH}x${STREAM_HEIGHT}"
echo "==================================="

# Run the bot
exec npm run start
