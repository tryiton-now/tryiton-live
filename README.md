# tryiton-live

Browser SDK for **TryItOn live try-on**: the shopper sees themselves wearing a garment in real time through their
webcam.

```bash
npm install tryiton-live
```

## How it fits together

```
Your server ──(API key)──▶ POST /api/v1/live/garments   prepare garments ahead (cached per image)
Your server ──(API key)──▶ POST /api/v1/live/sessions   → start response (session-scoped credentials only)
     │  send the start response to the browser
Browser ── tryiton-live ──▶ camera ⇄ WebRTC ⇄ media edge      video never passes through TryItOn's servers
Browser ── tryiton-live ──▶ heartbeat / garment switch / end  authenticated by the session's client secret
```

Your API key stays on your server. The browser only gets a short-lived media token and a secret for that one
session.

## Server (any language)

```js
// Once per product, e.g. at catalog sync:
const { garment } = await post("/live/garments", { garment_image: "https://cdn.example.com/shirt.jpg" });

// When a shopper opens live try-on:
const start = await post("/live/sessions", {
  garment_id: garment.id,
  end_user_id: shopper.id,                      // one stream per end user; a restart ends the old one
  allowed_origin: "https://shop.example.com",   // locks the media token to your site
});
// → return `start` to the browser as-is
```

## Browser

```js
import { attachStream, connectLiveTryOn, openCamera } from "tryiton-live";

// 1. Camera first: a session holds a credit from the moment it starts, and the permission prompt can take a while.
const camera = await openCamera();

// 2. Then ask your server to start the session.
const start = await fetch("/my-api/live-session", { method: "POST" }).then((r) => r.json());

const live = await connectLiveTryOn(start, {
  camera,
  onStream: (stream) => attachStream(video, stream),  // plays it, iOS included (see below)
  disclosure: videoContainer,                        // "AI-modified video" label while live (see below)
  onSecondsLeft: (s) => (timer.textContent = `${s}s`),
  onEnd: ({ reason, session }) => console.log(reason, session?.creditsCharged),
});

await live.switchGarment(otherGarmentId);   // same stream, no reconnect
await live.end();
```

If you don't pass `camera`, `connectLiveTryOn` opens the front camera itself. That's fine once permission has been
granted. It resolves when the try-on video arrives. If none arrives within `connectTimeoutMs` (default 20 s), it
rejects with a `TryItOnLiveError`. The session is then ended server-side, and a session that never streamed costs
nothing.

### Billing and ending

- Billed per `secondsPerCredit` (2 s per credit by default) from the first try-on frame, not from connect. The SDK
  sends the billing heartbeat for you, numbered (`seq`) so a retry is never charged twice. Ending charges the credit
  held at start, even when no video arrived; the API docs explain the
  [billing rules](https://docs.tryiton.now/docs/api-reference/live-tryon#billing).
- The server can end a stream at any heartbeat. `onEnd` gets the reason: `time_limit`, `out_of_credits`,
  `superseded`, …
- If two heartbeats in a row fail, the stream ends with `heartbeat_failed`. It never runs unbilled.
- Closing the tab ends the session with a keepalive request.

### AI disclosure

The try-on video shows a real person in AI-edited clothes. Under the EU AI Act (Art. 50) you have to tell viewers
the video is AI-modified. Pass `disclosure` and the SDK shows a small frosted "AI-modified video" label over the
element that holds your `<video>` while the try-on is live, and removes it when the session ends:

```js
connectLiveTryOn(start, {
  onStream: (s) => attachStream(video, s),
  disclosure: { container: videoContainer, label: "KI-veränderte Vorschau", position: "bottom-right" },
});
```

`showAiDisclosure(container, { label, position, inset })` shows the same label anywhere in your UI and returns a
function that removes it. If you show your own disclosure instead, keep it visible on the video while it plays.

### iOS Safari

- **Video:** show the stream with `attachStream(video, stream)`. It sets `muted` and `playsinline`, calls `play()`
  (iOS ignores `autoplay` in Low Power Mode) and resumes playback when the page is shown again.
- **Hidden page:** the session ends with reason `hidden` when the page is hidden. iOS pauses the camera and the stream
  when the shopper switches apps, and `pagehide` doesn't fire then. Start a new session when they come back.
  `endWhenHidden: false` turns this off.
- **Camera:** if the `camera` you pass has an ended track (iOS stopped it in the background), the session opens a fresh
  one. Call `openCamera()` again before each session to keep your own preview working.
- **Start from a tap.** Camera access is unreliable in in-app browsers (Instagram, TikTok, Facebook): check
  `navigator.mediaDevices?.getUserMedia` and suggest opening the page in Safari if it's missing.

### Bundlers

On Chromium, the media layer sends each outgoing video frame through a Web Worker. It loads that worker with
`new URL("./frame-metadata-worker.js", import.meta.url)`.

- **Vite, webpack 5, Next.js:** they emit the worker for you. Nothing to do.
- **esbuild, Bun, or a plain `<script type="module">` copy of the bundle:** copy
  `node_modules/@decartai/sdk/dist/realtime/browser/frame-metadata-worker.js` next to your bundle. Without it the
  camera connects but no video is sent, and `connectLiveTryOn` rejects with `connect_failed` after `connectTimeoutMs`.
  You aren't billed for that. `node node_modules/tryiton-live/scripts/copy-media-worker.mjs <outdir>` does the copy.

### Errors

`TryItOnLiveError.code`: `camera_denied`, `camera_unavailable`, `garment_required`, `busy`, `connect_failed`,
`heartbeat_failed`, `http_error` (with `status` and the API's `apiName`).

## Demo

```bash
npm install && npm run build:demo
TRYITON_API_KEY=... node examples/basic/server.mjs   # TRYITON_API_BASE to point at another environment
```

Then open http://localhost:5173. It needs a camera, and `localhost` counts as a secure context.
