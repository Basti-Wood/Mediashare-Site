# Mediashare

## Stream Deck controls

Open **Stream Deck** below the audio player. Download the plugin and
double-click the `.streamDeckPlugin` installer. In Stream Deck, drag **Skip
current song** onto a key and **Media volume / Pause** onto a Stream Deck + dial.
Create a connection token in the dashboard for the selected channel, then paste
the website address and token into an action's settings and click **Connect**.
The connection is shared by both actions and remembered by Stream Deck.

- Press the Skip key to advance the current song.
- Turn the dial clockwise/counterclockwise to raise/lower the app's media volume.
  Each tick changes it by 2% by default; choose 0.01–10% in the dial settings.
- Press the dial or tap its touch screen to pause; press or tap again to resume.

The dial display shows the current volume and paused state. Volume and playback
settings stay synchronized with the dashboard, pop-out and OBS. This controls
Mediashare audio, rather than the computer's master volume. Keep your player or
OBS browser source running for playback.

Requires Stream Deck 7.1 or newer on Windows 10+ or macOS 13+. Stream Deck runs the
plugin using its bundled Node 24; installing Node separately is unnecessary for
normal use. The website URL must use HTTPS, except HTTP localhost for development.

**Replace connection token** invalidates the previous token. **Disconnect**
revokes it immediately. Tokens are scoped to the selected channel, survive server
restarts and stop working after an account password change, account deletion or
removed channel access. Only token hashes are kept in `./data/streamdeck` under
the existing persistent data mount; no website password is stored in the plugin.
Keep `SESSION_SECRET` stable, as for remembered logins.

The installer and source are in [streamdeck](streamdeck/README.md). Developers can
rebuild the installer with `npm run streamdeck:pack`. After deploying this update,
refresh the dashboard to load the Stream Deck pairing panel. Install plugin
**1.0.1** to add touch-screen pause/resume and fractional dial sensitivity;
existing connection tokens are retained.

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

Metadata lookup and temporary YouTube downloads use `yt-dlp`; `ffmpeg` normalizes
uploaded MP3s and prepared audio. `ffprobe` checks the downloaded and normalized
files. The Docker image includes these tools and Node 24. Refresh the dashboard and OBS browser source after updating; both
scripts are versioned `request-video-1`.

## Playback errors and unavailable videos

Confirmed private, removed or unavailable YouTube videos are skipped automatically,
for both viewer requests and personal songs. A skipped unavailable track is
retired from the active personal queue so Loop cannot get stuck repeating it;
saved playlist snapshots remain available. The server verifies the current
playback ID and the actual download failure before advancing, so simultaneous
players cannot skip an extra song. Network errors, rate limits, missing server
tools and autoplay permission failures keep the current song queued and show
**Play / Retry** and **Skip this song**.

## Temporary YouTube media and preloading

Viewer-requested YouTube songs play with **video and sound** from a complete,
temporary MP4 on the server. The native player shows the video in the dashboard,
pop-out and OBS overlay, without a YouTube widget. Output is compatible H.264
video (up to 1280×720) with normalized AAC audio and seeking support. If a combined
video source fails, the server tries separate video/audio streams and merges
them. Completed files are probed and decoded before they can play.

Personal songs in **My List**, saved playlists loaded into My List and uploaded
MP3s remain **audio-only**. Their video stays hidden even if a viewer requested
the same YouTube ID earlier. Personal YouTube songs use an audio-only download
first, with a combined MP4 source as a fallback for extracting audio. Files stay
on the server rather than downloading to your computer. Dashboard and OBS share
completed files and download jobs within each cache.

While the current song plays, the server prepares the next **three tracks** in
queue order, including alternating mode, Loop and Play next uploads. Viewer
requests warm the video cache; personal songs warm the audio cache; local MP3s
already have files. This never consumes or reorders songs. The player shows
**Downloading** or **Preparing** until its complete file is ready. Its first
song can take time to prepare; later cached songs start promptly.

Temporary audio lives in `./data/youtube-cache` and requested videos in
`./data/youtube-video-cache`, separate from uploaded files and saved playlists.
Each cache uses at most **1 GB** by default (**2 GB combined**), excluding bounded
working space for active jobs. Individual source/output limits are **128 MB**
for audio and **256 MB** for video. Idle files expire after **six hours**; old
files are evicted first and current/served files are protected. Each cache runs
at most two jobs, prioritizing current playback. Obsolete pending jobs are
cancelled after queue changes or when players stop polling. Completed files
survive container restarts. Cleanup never deletes uploaded MP3s or saved playlists.

Configure `YOUTUBE_CACHE_MAX_MB`, `YOUTUBE_CACHE_ENTRY_MB`,
`YOUTUBE_VIDEO_CACHE_MAX_MB`, `YOUTUBE_VIDEO_CACHE_ENTRY_MB`,
`YOUTUBE_CACHE_TTL_HOURS`, `YOUTUBE_PREFETCH_COUNT` (0–10; 0 disables lookahead)
and `YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS` in the container environment. Live streams,
oversized videos and temporary server-wide YouTube blocks still show Retry/Skip.
Rebuild Docker with `--no-cache` to refresh yt-dlp when YouTube changes.

## Saved volume and shared Pause/Resume

Volume and paused state are saved for each user's channel and restored before
playback starts. They survive page reloads and server restarts, and are shared
by the dashboard preview, pop-out and OBS player. Use **Pause / Resume** on the
dashboard, the audio controls or Stream Deck. A saved volume of **0.5%** maps to
linear signal gain **0.005**, half the gain of **1%** (**0.01**). The old hidden
50% output cap is removed. Decimal dots and commas work in the percentage field;
the dial display preserves fractional values and its step can be set to 0.5%.
A short 5 ms gain ramp avoids clicks when changing volume. Requested videos, personal YouTube audio and MP3s
share this output; Spotify embeds retain their own volume controls.

Versioned settings keep Stream Deck, dashboard and OBS in sync even during local
saves: a pending volume save does not discard Pause, and older acknowledgements
cannot overwrite newer settings. Song duration comes from cached audio metadata,
without loading the YouTube iframe API.

Change settings from a signed-in dashboard or pop-out. OBS can read and follow
the saved settings without logging in. Each channel's preferences are separate;
moderators with access to a channel can adjust that channel's audio. Settings
live in `./data/audio-settings` under the same persistent data mount as MP3s.

If the Local Music playlist form is missing, verify that the feature pull request
has been merged and that your deployment has pulled that revision. Refresh the
dashboard and OBS browser source after updating. The updated overlay script is
versioned `request-video-1`.

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

Refresh the dashboard and OBS source afterward. Download and install the updated
Stream Deck plugin from the dashboard. The `streamdeck` folder is now mounted
alongside the source so future installer updates stay in sync with the site.
Uploaded MP3s and saved playlists live in
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
