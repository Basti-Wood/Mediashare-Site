FROM node:24-alpine
WORKDIR /app

# yt-dlp downloads temporary complete media for native audio/video playback.
# The official executable bundles the challenge solver scripts. YouTube also
# needs an enabled Node runtime >=22 (downloads pass --js-runtimes node).
# Python runs the executable; ffmpeg/ffprobe prepare and check cached MP3s and H.264/AAC MP4s.
RUN apk add --no-cache python3 ffmpeg ca-certificates wget \
    && wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "scrs/backend/server.js"]
