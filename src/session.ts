import { createLiveApi, DEFAULT_API_BASE_URL, type LiveApi } from "./api";
import { TryItOnLiveError } from "./errors";
import { showAiDisclosure } from "./disclosure";
import { connectDecart, type MediaConnection, type MediaConnector } from "./media";
import type { ConnectOptions, GarmentInput, LiveEndReason, LiveEndResult, LiveGarment, LiveSessionSummary, LiveStartResponse, LiveStatus } from "./types";

// Session engine: camera → WebRTC to the media provider → prepaid billing heartbeats every `secondsPerCredit`
// seconds while media flows → end. The server is the source of truth for the balance: a heartbeat answering
// { stop } ends the stream at once, and the stream never runs unbilled (two failed heartbeats end it).
// Mirrors the TryItOn web app's engine (tryiton/frontend/hooks/useLiveSessionCore.js).

const MAX_HEARTBEAT_FAILURES = 2;
const HEARTBEAT_RETRY_MS = 2000;

/** Front camera at the model's native 16:9 (never portrait: browsers crop the sensor to match). */
const DEFAULT_CAMERA: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
};

export interface SessionDeps {
  api: LiveApi;
  connectMedia: MediaConnector;
  getCamera: () => Promise<MediaStream>;
  /** Where to listen for `pagehide`; null outside a browser. */
  pageEvents: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  now: () => number;
}

/**
 * Open the front camera the way live try-on wants it (1280×720, 30 fps). Call it **before** your server starts the
 * session: a permission prompt can take a while, and a started session holds a credit until it streams.
 * Pass the result as `{ camera }`; you own it then (stop its tracks when done).
 * @throws TryItOnLiveError `camera_denied` | `camera_unavailable`
 */
export const openCamera = async (): Promise<MediaStream> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    throw new TryItOnLiveError("camera_unavailable", "This browser can't open a camera (it needs HTTPS and camera support).");
  try {
    return await navigator.mediaDevices.getUserMedia(DEFAULT_CAMERA);
  } catch (err: any) {
    const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    throw new TryItOnLiveError(denied ? "camera_denied" : "camera_unavailable", err?.message || "Couldn't open the camera.");
  }
};

const assertStart = (start: LiveStartResponse) => {
  if (!start?.session?.id || !start.clientSecret || !start.connection?.token)
    throw new TypeError("connectLiveTryOn needs the full response of POST /api/v1/live/sessions (session, clientSecret, connection).");
};

export class LiveTryOnSession {
  readonly sessionId: string;
  status: LiveStatus = "connecting";
  secondsLeft: number;

  private readonly start: LiveStartResponse;
  private readonly opts: ConnectOptions;
  private readonly deps: SessionDeps;
  private readonly startedAt: number;
  private readonly secondsPerCredit: number;
  private camera: MediaStream | null = null;
  private ownsCamera = false;
  private media: MediaConnection | null = null;
  private hideDisclosure: (() => void) | null = null;
  private connected = false;
  private connectMs: number | null = null;
  private nextTickAt = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailures = 0;
  // Ticks the server has settled; each heartbeat names the next one (seq), so a retry can't be charged twice.
  private settledTicks = 0;
  private ended: Promise<LiveEndResult> | null = null;
  private readonly onPageHide = () => this.unload();

  /** Use connectLiveTryOn(); the constructor is public for tests and advanced wiring only. */
  // A getter on purpose: callbacks flip `status` between awaits, so it must be re-read, not narrowed.
  private get isEnded(): boolean {
    return this.status === "ended";
  }

  constructor(start: LiveStartResponse, opts: ConnectOptions, deps: SessionDeps) {
    assertStart(start);
    this.start = start;
    this.opts = opts;
    this.deps = deps;
    this.sessionId = start.session.id;
    this.secondsLeft = start.secondsLeft;
    this.secondsPerCredit = start.secondsPerCredit;
    this.startedAt = deps.now();
  }

  /**
   * Open the camera and the stream. Resolves once edited frames flow (billing starts then); rejects with a
   * TryItOnLiveError if it never gets there, after ending the session server-side (an unstreamed session
   * gives its held credit back).
   */
  async open(): Promise<this> {
    this.deps.pageEvents?.addEventListener("pagehide", this.onPageHide);

    let input: GarmentInput;
    try {
      input = await this.firstGarmentInput();
      if (this.opts.camera)
        this.camera = this.opts.camera;
      else {
        this.camera = await this.deps.getCamera();
        this.ownsCamera = true;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.finish("error", { error });
      throw error;
    }

    if (this.isEnded)
      throw new TryItOnLiveError("connect_failed", "The session ended before it connected.");

    return new Promise((resolve, reject) => {
      this.media = this.deps.connectMedia({
        provider: this.start.connection.provider,
        model: this.start.connection.model,
        token: this.start.connection.token,
        camera: this.camera as MediaStream,
        input,
        ...(this.opts.connectTimeoutMs != null && { connectTimeoutMs: this.opts.connectTimeoutMs }),
        onRemoteStream: (stream) => this.opts.onStream?.(stream),
        // Serialized so the details survive log collectors that don't expand objects.
        ...(this.opts.debug && {
          log: (message: string, data?: unknown) =>
            console.debug("[tryiton-live]", message, typeof data === "string" || data === undefined ? (data ?? "") : JSON.stringify(data)),
        }),
        onConnected: () => {
          this.onConnected();
          resolve(this);
        },
        onFailure: (error, { busy }) => {
          const wrapped = new TryItOnLiveError(busy ? "busy" : "connect_failed", busy ? "The live service is at capacity. Try again in a moment." : error.message);
          const wasConnected = this.connected;
          void this.finish("error", { error: wrapped });
          if (!wasConnected)
            reject(wrapped);
        },
      });
    });
  }

  /**
   * Swap the garment on the running stream (same session, no reconnect). The garment must be prepared on your
   * account (POST /api/v1/live/garments).
   */
  async switchGarment(garmentId: string): Promise<LiveGarment> {
    if (this.isEnded)
      throw new TryItOnLiveError("connect_failed", "The session has ended.");
    const garment = await this.deps.api.switchGarment(garmentId);
    if (garment.input && !this.isEnded)
      this.media?.send(garment.input);

    return garment;
  }

  /** End the session (idempotent). Resolves with the final usage. */
  end(reason: LiveEndReason = "user"): Promise<LiveEndResult> {
    return this.finish(reason);
  }

  private async firstGarmentInput(): Promise<GarmentInput> {
    if (this.start.garment?.input)
      return this.start.garment.input;
    if (this.opts.garmentId) {
      const garment = await this.deps.api.switchGarment(this.opts.garmentId);
      if (garment.input)
        return garment.input;
    }

    throw new TryItOnLiveError("garment_required", "Start the session with a garment_id, or pass { garmentId } to connectLiveTryOn.");
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status)
      return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }

  private setSecondsLeft(seconds: number) {
    this.secondsLeft = Math.max(0, seconds);
    this.opts.onSecondsLeft?.(this.secondsLeft);
  }

  // The AI-disclosure label is up exactly while edited video is live.
  private showDisclosure() {
    const d = this.opts.disclosure;
    if (!d || this.hideDisclosure)
      return;
    const { container, ...opts } = "container" in d ? d : { container: d };
    this.hideDisclosure = showAiDisclosure(container, opts);
  }

  private onConnected() {
    if (this.connected || this.isEnded)
      return;
    this.connected = true;
    this.connectMs = this.deps.now() - this.startedAt;
    this.setStatus("live");
    this.showDisclosure();
    // Billing clock starts when media actually flows.
    this.nextTickAt = this.deps.now() + this.secondsPerCredit * 1000;
    this.heartbeatTimer = setTimeout(() => void this.heartbeat(), this.secondsPerCredit * 1000);
    this.countdownTimer = setInterval(() => this.setSecondsLeft(this.secondsLeft - 1), 1000);
  }

  private async heartbeat() {
    if (this.isEnded)
      return;
    try {
      const result = await this.deps.api.heartbeat(this.connectMs, this.settledTicks + 1);
      if (this.isEnded)
        return;
      this.heartbeatFailures = 0;
      if (result.stop) {
        await this.finish(result.reason || "error", { serverStopped: true, session: result.session || null });
        return;
      }
      if (typeof result.secondsLeft === "number")
        this.setSecondsLeft(result.secondsLeft);
      // The server's count wins: after a retry whose first attempt did land, the next heartbeat names the next tick.
      if (typeof result.ticks === "number")
        this.settledTicks = result.ticks;
      else
        this.settledTicks += 1; // a server that doesn't report ticks ignores seq anyway
      // Fixed cadence from connect (not from this response), so request time doesn't stretch each tick. Half a
      // tick minimum clears the server's burst guard when catching up after a retry.
      this.nextTickAt += this.secondsPerCredit * 1000;
      this.heartbeatTimer = setTimeout(() => void this.heartbeat(), Math.max(this.secondsPerCredit * 500, this.nextTickAt - this.deps.now()));
    } catch (err) {
      if (this.isEnded)
        return;
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        const message = err instanceof Error ? err.message : String(err);
        await this.finish("error", { error: new TryItOnLiveError("heartbeat_failed", `Billing heartbeat failed: ${message}`) });
        return;
      }
      // A retry of a tick the server already counted is answered without a charge (same seq).
      this.heartbeatTimer = setTimeout(() => void this.heartbeat(), HEARTBEAT_RETRY_MS);
    }
  }

  private teardown() {
    if (this.heartbeatTimer)
      clearTimeout(this.heartbeatTimer);
    if (this.countdownTimer)
      clearInterval(this.countdownTimer);
    this.heartbeatTimer = null;
    this.countdownTimer = null;
    this.media?.close();
    this.media = null;
    this.hideDisclosure?.();
    this.hideDisclosure = null;
    if (this.ownsCamera)
      this.camera?.getTracks().forEach((t) => t.stop());
    this.deps.pageEvents?.removeEventListener("pagehide", this.onPageHide);
  }

  // Idempotent: tears down locally, then tells the server unless the server ended it.
  private finish(
    reason: LiveEndReason,
    { serverStopped = false, session = null, error = null }: { serverStopped?: boolean; session?: LiveSessionSummary | null; error?: Error | null } = {},
  ): Promise<LiveEndResult> {
    if (this.ended)
      return this.ended;
    this.teardown();
    this.setStatus("ended");

    this.ended = (async () => {
      let summary = session;
      if (!serverStopped)
        try {
          summary = await this.deps.api.end({
            reason,
            connected: this.connected,
            ...(this.connectMs != null && { connect_ms: this.connectMs }),
            ...(error && { error: error.message.slice(0, 300) }),
          });
        } catch {
          // Best-effort: the server's stale-session sweeper settles it.
        }
      const result: LiveEndResult = { reason, session: summary, error };
      this.opts.onEnd?.(result);

      return result;
    })();

    return this.ended;
  }

  // The page is going away: no awaiting, a keepalive request instead.
  private unload() {
    if (this.ended)
      return;
    this.teardown();
    this.setStatus("ended");
    this.deps.api.endOnUnload({ reason: "unload", connected: this.connected, ...(this.connectMs != null && { connect_ms: this.connectMs }) });
    const result: LiveEndResult = { reason: "unload", session: null, error: null };
    this.ended = Promise.resolve(result);
    this.opts.onEnd?.(result);
  }
}

/**
 * Start streaming a live try-on session your server created with `POST /api/v1/live/sessions`.
 * Resolves once the try-on video is live; rejects with a TryItOnLiveError otherwise.
 *
 * @example
 *   const start = await fetch("/my-server/live-session", { method: "POST" }).then((r) => r.json());
 *   const live = await connectLiveTryOn(start, { onStream: (s) => (video.srcObject = s), onEnd: console.log });
 *   await live.switchGarment(otherGarmentId);
 *   await live.end();
 */
export function connectLiveTryOn(
  start: LiveStartResponse,
  opts: ConnectOptions = {},
  deps: Partial<SessionDeps> = {},
): Promise<LiveTryOnSession> {
  assertStart(start);
  const session = new LiveTryOnSession(start, opts, {
    api:
      deps.api ||
      createLiveApi({ baseUrl: opts.apiBaseUrl || DEFAULT_API_BASE_URL, sessionId: start.session.id, secret: start.clientSecret }),
    connectMedia: deps.connectMedia || connectDecart,
    getCamera: deps.getCamera || openCamera,
    pageEvents: deps.pageEvents !== undefined ? deps.pageEvents : typeof window !== "undefined" ? window : null,
    now: deps.now || (() => Date.now()),
  });

  return session.open();
}
