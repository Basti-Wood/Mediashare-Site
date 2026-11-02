# Mediashare Stream Deck plugin

Install `com.bastiwood.mediashare.streamDeckPlugin` by double-clicking it, or use
the dashboard's **Stream Deck → Download the Mediashare plugin** link.

The **Skip current song** key advances the current track. The **Media volume /
Pause** encoder adjusts the media volume and pauses/resumes when pressed. Assign
the latter to a dial on Stream Deck +. Dial sensitivity defaults to 2 percentage
points per tick and is configurable from 1 to 10.

In the dashboard, create a connection token for your channel. In either action's
settings, enter the website address and token, then click **Connect**. The plugin
verifies the token before saving it in Stream Deck's global plugin settings.
Both actions share that connection. Use HTTPS, or HTTP localhost for development.
Tokens grant only playback control of their paired channel. Use the dashboard's
**Disconnect** button to revoke a token; replacing it revokes the previous copy.

The dial refreshes shared playback settings once a second. Relative adjustments
are computed by the server, so website edits and rapid dial turns do not overwrite
each other with stale absolute values. Pending turns in the same direction are
combined; reversals and button presses retain their order. Commands have unique
request IDs, preventing replayed requests from skipping/toggling twice. Failed
commands show an alert and are not automatically repeated.

## Development

The `com.bastiwood.mediashare.sdPlugin` folder is the complete plugin source. It
uses the documented Elgato local WebSocket protocol and Node 24's built-in fetch
and WebSocket APIs, with no runtime npm dependencies. The property inspector is
local HTML/JavaScript. No remote scripts or services are needed for its UI.

From the repository root, using Node 24+:

```sh
npm run streamdeck:pack
npm test
```

The pinned official Elgato CLI validates and packs the source. Commit the updated
installer whenever the plugin source changes. The bundled installer is served
as a public download at `/api/streamdeck/plugin`; control calls require a token.

The tests run real local HTTP requests, simulate key/dial and property inspector
events, and start the plugin in a separate Node process connected to a simulated
Stream Deck WebSocket server. Physical Stream Deck hardware and the desktop
application are not available in the test environment.

Reference: [Elgato WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/),
[manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/), and
[plugin packaging](https://docs.elgato.com/streamdeck/cli/commands/pack/).

## Channel control API

The signed-in dashboard manages its own connection with GET, POST (create/rotate)
and DELETE (revoke) on `/api/streamdeck/:channel/connection`. The plaintext token
is returned only on creation. Its hash and account credential version are saved
privately under `data/streamdeck`, excluded from Git and Docker build contexts.

The plugin sends `Authorization: Bearer msd_…` to:

- `GET /api/streamdeck/state`: paired channel, shared `settings` (volume/paused)
  and the current `playbackId`, when a player has reported one.
- `POST /api/streamdeck/control`: an `action`, unique `requestId` (8–80 letters,
  digits, underscores or hyphens), and action-specific parameters. Actions are
  `skip` (optional `playbackId` to guard against an already finished song),
  `adjust-volume` (nonzero integer `delta` between -100 and 100), and
  `toggle-pause`. The server always uses the token's channel.

Responses include the updated shared state. Reusing the same request ID and
payload returns the existing result for two minutes; a different payload with
the same ID returns 409. Skip uses the same playback lock and identity guard as
the overlay's finish event, preserving loops and alternate playback mode.
