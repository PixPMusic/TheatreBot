# Theatre Bot Container
# Runs Chromium with Xvfb + PulseAudio for Discord streaming

FROM registry.fedoraproject.org/fedora-minimal:43

# Enable RPM Fusion for full FFmpeg (x11grab, pulse, libx264)
RUN microdnf install -y \
    https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-43.noarch.rpm \
    && microdnf clean all

# Install dependencies using microdnf
RUN microdnf install -y \
    # X11 virtual framebuffer
    xorg-x11-server-Xvfb \
    # Audio
    pulseaudio \
    pulseaudio-utils \
    # Browser (Chromium from Fedora repos - works on ARM and x86)
    chromium \
    chromium-headless \
    chromedriver \
    # Utilities
    dbus \
    procps-ng \
    unzip \
    tar \
    xz \
    wget \
    && microdnf clean all

# Install BtbN FFmpeg (Static Build with libzmq)
RUN ARCH=$(uname -m) \
    `# Auto-detect architecture (amd64 or arm64)` \
    && if [ "$ARCH" = "x86_64" ]; then ARCH="linux64"; elif [ "$ARCH" = "aarch64" ]; then ARCH="linuxarm64"; else echo "Unsupported arch: $ARCH"; exit 1; fi \
    && echo "Downloading FFmpeg for $ARCH..." \
    && wget -qO ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-$ARCH-gpl.tar.xz" \
    && tar -xf ffmpeg.tar.xz \
    && mv ffmpeg-master-latest-$ARCH-gpl/bin/ffmpeg /usr/bin/ffmpeg \
    && mv ffmpeg-master-latest-$ARCH-gpl/bin/ffprobe /usr/bin/ffprobe \
    && rm -rf ffmpeg.tar.xz ffmpeg-master-latest-$ARCH-gpl \
    && chmod +x /usr/bin/ffmpeg /usr/bin/ffprobe

# Install Node.js and NPM
RUN microdnf install -y nodejs npm && microdnf clean all \
    && node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 4)) throw new Error('Node.js >=22.4.0 is required');"

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Set up display and audio environment
ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/run/pulse/native

# Expose web UI port
EXPOSE 8080

# Start script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
