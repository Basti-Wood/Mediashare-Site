FROM node:24-alpine
WORKDIR /app

# yt-dlp (used to resolve direct YouTube audio stream URLs so playback runs in a
# same-origin <audio> element instead of the YouTube iframe — the iframe gets
# suspended by the browser in a background tab; a native audio element does not).
# The official executable bundles the challenge solver scripts. YouTube also
# needs an enabled Node runtime >=22 (the resolver passes --js-runtimes node).
# Python runs the executable; ffmpeg converts and normalizes audio.
RUN apk add --no-cache python3 ffmpeg ca-certificates wget \
    && wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "scrs/backend/server.js"]
