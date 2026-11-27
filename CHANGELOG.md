# Changelog

All notable changes to `tryiton-live` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Added

- AI disclosure for the try-on video (EU AI Act Art. 50): `connectLiveTryOn(start, { disclosure: container })` shows
  an "AI-modified video" label over your video container while edited video is live and removes it when the session
  ends. `showAiDisclosure(container, { label, position, inset })` does the same for your own UI, and returns a
  function that removes it.

## [0.1.0] - Unreleased

First release: the browser side of TryItOn live (real-time webcam) try-on.

### Added

- `connectLiveTryOn(start, options)` streams a session your server started with `POST /api/v1/live/sessions`. It
  resolves at the first try-on frame and rejects with `TryItOnLiveError` otherwise.
- `openCamera()`, so you can get camera permission before your server starts a billed session.
- `LiveTryOnSession`: `switchGarment(id)` swaps garments on the running stream without reconnecting, and `end()` is
  idempotent.
- Billing heartbeats that start at the first try-on frame (the first decoded frame, not just a video track) and run
  on a fixed cadence. Each names the tick it settles (`seq`), so a retried heartbeat is never charged twice. Two
  failed heartbeats end the stream, so it never runs unbilled. Closing the page sends a keepalive end request.
- `connectTimeoutMs` (default 20 s): a stream that never produces video fails and ends the session. Only the credit
  held at start is charged.
- `debug: true` logs connection states, provider diagnostics and transport stats.
- `scripts/copy-media-worker.mjs` for bundlers that don't emit `new URL(…, import.meta.url)` workers, such as
  esbuild.
- A runnable demo in `examples/basic`.
