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

## Saved playlists and next-song uploads

Open **Local Music** (the third tab), paste a public or unlisted YouTube playlist
URL, and click **Save & load playlist**. This saves the playlist's links, titles
and original order, then replaces **all upcoming My List songs** and selects
My List playback. The currently playing song finishes first. No playlist MP3s
are downloaded or stored. Unavailable entries are skipped; an unreadable or
cancelled import leaves the previous music list intact.

Saved playlists remain visible in Local Music. **Load & replace My List** loads
the saved snapshot again, replacing the upcoming list. Reimport the URL to
refresh it from YouTube. Pasting a playlist into My List uses the same save and
replace behavior. Loop and Shuffle apply to the loaded songs; saved snapshots
retain their original order. Both saved playlists and the upcoming list survive
server restarts in `./data/local-media/.library`.

**Upload & play next** saves an MP3 and queues it after the current song, before
other requests or playlist tracks. Multiple files retain their upload order.
Individual files use **Play next** to queue a saved MP3 again; these one-off songs
play once even when playlist Loop is on. **Play now** explicitly interrupts the
current song. Adding a whole folder appends its files to My List. Uploading again
with the same filename creates a numbered copy. Replacing a playlist changes the
upcoming list; uploaded files and other saved playlists remain available to load.

The site sends each song's `song_name` and `platform` to Basti-API when it becomes
current, including uploaded filenames. Update Basti-API with its accompanying
metadata change so `/getallmedia` and the Twitch bot also receive those names.
Older API versions ignore these query parameters; the dashboard still shows the
known filename for the current song.

Metadata lookup and live YouTube audio playback use `yt-dlp`; `ffmpeg` normalizes
uploaded MP3s and the live audio stream. The existing Docker image includes both
and Node 24. Refresh the dashboard and OBS browser source after updating; both
scripts are versioned `saved-playlists-1`.

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

If the Local Music playlist form is missing, verify that the feature pull request
has been merged and that your deployment has pulled that revision. Refresh the
dashboard and OBS browser source after updating. The updated overlay script is
versioned `saved-playlists-1`.

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

Refresh the dashboard afterward. Uploaded MP3s and saved playlists live in
`./data/local-media` on the host and survive container recreation. My List is
also persisted there; play-mode and loop settings still use in-memory storage.
The uncached rebuild is needed to install the newer Node runtime and refresh
yt-dlp; a plain container restart keeps the old image and dependencies.

## Tests

```sh
npm ci
npm test
```

The suite uses temporary media folders and simulated Basti, YouTube and downloader
responses. It does not download real music or require your account credentials.
