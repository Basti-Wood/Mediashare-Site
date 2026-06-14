FROM node:20-alpine
WORKDIR /app

# yt-dlp (used to resolve direct YouTube audio stream URLs so playback runs in a
# same-origin <audio> element instead of the YouTube iframe — the iframe gets
# suspended by the browser in a background tab; a native audio element does not).
# Requires python3 + ffmpeg. Installed as a static binary so it's self-contained.
RUN apk add --no-cache python3 ffmpeg ca-certificates wget \
    && wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "scrs/backend/server.js"]
