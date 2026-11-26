# Changelog

All notable changes to `tryiton-live` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release: the browser side of TryItOn live (real-time webcam) try-on.

### Added

- `connectLiveTryOn(start, options)` streams a session your server started with `POST /api/v1/live/sessions`. It
  resolves at the first try-on frame and rejects with `TryItOnLiveError` otherwise.
- `openCamera()`, so you can get camera permission before your server starts a billed session.
- `LiveTryOnSession`: `switchGarment(id)` swaps garments on the running stream without reconnecting, and `end()` is
  idempotent.
- Billing heartbeats that start at the first try-on frame and run on a fixed cadence. Two failed heartbeats end the
  stream, so it never runs unbilled. Closing the page sends a keepalive end request.
- `connectTimeoutMs` (default 20 s): a stream that never produces video fails without being billed.
- `debug: true` logs connection states, provider diagnostics and transport stats.
- `scripts/copy-media-worker.mjs` for bundlers that don't emit `new URL(…, import.meta.url)` workers, such as
  esbuild.
- A runnable demo in `examples/basic`.
