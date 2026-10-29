# Mediashare

## Stay signed in

Leave **Stay signed in for 30 days** checked when logging in. Your browser will
open the dashboard automatically on later visits, and activity renews the
remembered login. Uncheck it to use a browser-session cookie instead.

Login sessions survive server restarts using `./data/sessions` under the
persistent Docker data mount. Cookies contain an opaque session ID; passwords
are not saved in cookies or browser storage. The cookies are HttpOnly,
SameSite=Lax, and Secure when served over HTTPS. Logging out revokes the current
browser's session. Changing an account's password or removing the account also
invalidates its remembered logins.

Keep `SESSION_SECRET` stable between deployments. If it is unset, the server
creates a private signing secret in the persistent session directory. Changing
the secret requires users to sign in again. `TRUST_PROXY=1` assumes the existing
single reverse proxy; use `TRUST_PROXY=0` for a direct HTTP deployment.

After installing this update, sign in once to create the new remembered cookie.
Session data is excluded from Git and Docker builds and blocked from direct web
downloads.

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
`yt-dlp`, `ffmpeg` and Node.js; the Docker image includes them. The image uses
Node 24, satisfying yt-dlp's Node 22+ requirement for YouTube challenge solving.
The audio resolver and importer explicitly enable the Node runtime. See the
[yt-dlp runtime requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS#node).

## If songs immediately skip or audio returns 502

Audio loading failures keep the current song queued. A failed YouTube audio
proxy switches to YouTube's embedded player; failed MP3 or embedded playback
shows **Play / Retry** and **Skip this song**. Only a completed song or an
explicit Skip advances the queue. Autoplay permission failures ask for a click.

## Saved volume and shared Pause/Resume

Volume and paused state are saved for each user's channel and restored before
playback starts. They survive page reloads and server restarts, and are shared
by the dashboard preview, pop-out and OBS player. Use **Pause / Resume** on the
dashboard or the player's controls. Pausing the YouTube picture also pauses its
native audio stream; it no longer leaves the sound playing separately.

Change settings from a signed-in dashboard or pop-out. OBS can read and follow
the saved settings without logging in. Each channel's preferences are separate;
moderators with access to a channel can adjust that channel's audio. Settings
live in `./data/audio-settings` under the same persistent data mount as MP3s.

For an older deployed version, append `&ytmode=iframe` to the existing overlay
URL as a temporary way to bypass the audio proxy. The permanent fix also updates
the resolver, retains its HTTP headers, and removes stale stream URLs on failure.

If the Local Files playlist form is missing, verify that the feature pull request
has been merged and that your deployment has pulled that revision. Refresh the
dashboard and OBS browser source after updating. The updated overlay script is
versioned `audio-settings-4`.

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
docker compose build --pull --no-cache
docker compose up -d
```

Refresh the dashboard afterward. Uploads and downloads now live in
`./data/local-media` on the host and survive container recreation. My List and
play-mode settings still use the application's existing in-memory storage.
The uncached rebuild is needed to install the newer Node runtime and refresh
yt-dlp; a plain container restart keeps the old image and dependencies.

## Tests

```sh
npm ci
npm test
```

The suite uses temporary media folders and simulated Basti, YouTube and downloader
responses. It does not download real music or require your account credentials.
