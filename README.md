# Mediashare

## Loop and shuffle

The **Loop My List: On/Off** and **Shuffle My List** buttons sit directly below
Play Mode, above all three tabs. They work on your personal list, including local
MP3s queued there. Shuffle changes the upcoming order and keeps the current song
playing. Loop repeats the list until switched off.

## Save a YouTube playlist as MP3s

1. Open **Local Files**. Select a destination folder, or leave **all folders**
   selected to create a new folder named after the playlist ID.
2. Paste a public or unlisted YouTube playlist URL and click
   **Save playlist as MP3s**.
3. Watch the progress below the button. You can leave the tab or reload the page;
   the server continues downloading. **Cancel download** stops the remaining
   downloads and keeps completed songs.
4. Click **Add these files to My List** to queue the folder, or **+ My List** next
   to an individual MP3. Use the visible Loop and Shuffle buttons to control it.

Downloads preserve playlist order in numbered filenames. Unavailable tracks are
reported while the remaining tracks continue. Existing files are kept. This uses
`yt-dlp`, `ffmpeg` and Node.js; the Docker image includes them. If YouTube changes
its download behavior, rebuild the image to get the current `yt-dlp` release.

## Update an existing Docker installation

Before the first update that adds the persistent data mount, preserve any MP3s
already stored inside your running container:

```sh
mkdir -p data
docker compose cp mediashare:/app/data/local-media ./data/
```

If you have no existing local MP3s, skip the copy. Then update the source and
recreate the container:

```sh
git pull
docker compose up -d --build
```

Refresh the dashboard afterward. Uploads and downloads now live in
`./data/local-media` on the host and survive container recreation. My List and
play-mode settings still use the application's existing in-memory storage.

## Tests

```sh
npm ci
npm test
```

The suite uses temporary media folders and simulated Basti, YouTube and downloader
responses. It does not download real music or require your account credentials.
