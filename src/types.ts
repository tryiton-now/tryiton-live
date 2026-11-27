import type { AiDisclosureOptions } from "./disclosure";

/** What the stream needs for one garment (from the start response or a switch). */
export interface GarmentInput {
  prompt: string;
  enhancePrompt: boolean;
  /** JPEG data URI. */
  referenceImage: string;
}

export interface LiveGarment {
  id: string;
  category: string;
  subcategory: string | null;
  description: string | null;
  input?: GarmentInput;
}

export interface LiveSessionSummary {
  id: string;
  status: "active" | "ended";
  endReason: string | null;
  /** Streamed seconds once ended; billed ticks (rounded up) while running. */
  seconds: number;
  creditsCharged: number;
  endUserId: string | null;
}

/**
 * The body your server got back from `POST /api/v1/live/sessions`. Pass it to the browser as-is:
 * it carries only session-scoped credentials, never your API key.
 */
export interface LiveStartResponse {
  session: LiveSessionSummary;
  clientSecret: string;
  connection: { provider: string; model: string; token: string };
  secondsPerCredit: number;
  maxSeconds: number;
  secondsLeft: number;
  garment?: LiveGarment | null;
}

export type LiveStatus = "connecting" | "live" | "ended";

/**
 * Why a session ended. Server-decided: `time_limit`, `out_of_credits`, `budget`, `stale`, `superseded`.
 * Client-decided: `user`, `idle`, `hidden`, `error`, `unload`.
 */
export type LiveEndReason =
  | "user"
  | "idle"
  | "hidden"
  | "error"
  | "unload"
  | "time_limit"
  | "out_of_credits"
  | "budget"
  | "stale"
  | "superseded"
  | (string & {});

export interface LiveEndResult {
  reason: LiveEndReason;
  /** Final usage, when the server answered. */
  session: LiveSessionSummary | null;
  error: Error | null;
}

export interface ConnectOptions {
  /**
   * Camera to send, ideally from `openCamera()` called before your server started the session. Default: opens the
   * front camera at 1280×720, 30 fps here (and stops it when the session ends).
   */
  camera?: MediaStream;
  /** Give up (unbilled) if no try-on video arrives within this many ms. Default 20000. */
  connectTimeoutMs?: number;
  /** Default `https://tryiton.now/api/v1`. */
  apiBaseUrl?: string;
  /** Garment to start with when the start response carries none. */
  garmentId?: string;
  /** The try-on video. Attach it to a `<video autoplay playsinline muted>`. */
  onStream?: (stream: MediaStream) => void;
  /**
   * Show an "AI-modified video" label over the try-on video while it's live (EU AI Act Art. 50 disclosure). Pass the
   * element that contains your `<video>`, or `{ container, label, position }`. Recommended: if you leave it out, show
   * your own disclosure (see `showAiDisclosure`).
   */
  disclosure?: HTMLElement | (AiDisclosureOptions & { container: HTMLElement });
  /**
   * End the session (reason `hidden`) when the page is hidden: another tab, another app, a locked phone. Default true.
   * A hidden page can't show the video, and iOS pauses the camera, so the stream would only run (and bill) unseen.
   */
  endWhenHidden?: boolean;
  onStatusChange?: (status: LiveStatus) => void;
  /** Seconds the stream may still run, updated every second while live and on every heartbeat. */
  onSecondsLeft?: (seconds: number) => void;
  /** Called once, whoever ended it. */
  onEnd?: (result: LiveEndResult) => void;
  /** Log media connection states and provider errors to the console (`[tryiton-live]`). */
  debug?: boolean;
}
