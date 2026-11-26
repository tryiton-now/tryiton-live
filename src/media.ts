import { createConsoleLogger, createDecartClient, models } from "@decartai/sdk";
import type { GarmentInput } from "./types";

// The only module that knows the media vendor (Decart Lucy VTON realtime). The device streams straight to
// Decart over WebRTC with the short-lived token our backend minted; nothing here touches TryItOn's servers.
// Ported from the TryItOn web app / extension client (tryiton/frontend/lib/liveTryonClient.js).

/** A running media connection. */
export interface MediaConnection {
  /** Swap the garment on the running stream (no reconnect). */
  send(input: GarmentInput): void;
  close(): void;
}

export interface MediaConnectOptions {
  provider: string;
  model: string;
  token: string;
  camera: MediaStream;
  input: GarmentInput;
  onRemoteStream(stream: MediaStream): void;
  /** Once, when the provider session is up and an edited video track has arrived. Billing starts here. */
  onConnected(): void;
  /** Fail if that hasn't happened by then. Default 20 s. */
  connectTimeoutMs?: number;
  /** Fatal: the media session is over. `busy` = the provider's concurrent-session limit. */
  onFailure(error: Error, info: { busy: boolean }): void;
  /** Diagnostics (connection states, provider errors) when the caller enabled `debug`. */
  log?: (message: string, data?: unknown) => void;
}

export type MediaConnector = (opts: MediaConnectOptions) => MediaConnection;

const isBusy = (text: string | undefined | null) => /session.?limit/i.test(text || "");

// Connect + first edited frame normally takes ~2-3 s.
export const DEFAULT_CONNECT_TIMEOUT_MS = 20 * 1000;

const toLucyState = (input: GarmentInput) => ({ prompt: { text: input.prompt, enhance: input.enhancePrompt }, image: input.referenceImage });

/** Default connector: Decart Lucy VTON realtime via @decartai/sdk. */
export const connectDecart: MediaConnector = (opts) => {
  if (opts.provider !== "decart")
    throw new Error(`Unsupported live provider "${opts.provider}". Update tryiton-live.`);

  // Loosely typed: the vendor SDK's connection type is internal to this adapter.
  let rt: any = null;
  let closed = false;
  let lastError: string | null = null;
  // onConnected (which starts billing) needs both: the provider session up AND an edited video track back. Decart
  // reports "connected" once our camera is published, even if no edited frame ever arrives.
  let sessionUp = false;
  let hasVideo = false;
  let reported = false;

  const reportIfFlowing = () => {
    if (closed || reported || !sessionUp || !hasVideo)
      return;
    reported = true;
    clearTimeout(noVideoTimer);
    opts.onConnected();
  };

  const fail = (error: Error) => {
    if (closed)
      return;
    closed = true;
    clearTimeout(noVideoTimer);
    try {
      rt?.disconnect();
    } catch {
      /* already gone */
    }

    opts.onFailure(error, { busy: isBusy(error.message) });
  };

  const onState = (state: string) => {
    opts.log?.("connection", state);
    if (closed)
      return;
    if (state === "connected" || state === "generating") {
      sessionUp = true;
      reportIfFlowing();
    }
    // "reconnecting" is retried by the SDK; "disconnected" is final.
    else if (state === "disconnected" && rt)
      fail(new Error(lastError ? `Live connection lost: ${lastError}` : "Live connection closed"));
  };

  // No edited frame in time: fail unbilled (the session ends as never streamed, so its hold is returned).
  const noVideoTimer = setTimeout(
    () => fail(new Error("No video from the live service. Please try again.")),
    opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );

  const client = createDecartClient({
    apiKeyProvider: () => opts.token,
    telemetry: false,
    // Vendor-level logs only when the caller asked for diagnostics.
    ...(opts.log && { logger: createConsoleLogger("debug") }),
  } as any);

  client.realtime
    .connect(opts.camera, {
      model: models.realtime(opts.model as any),
      onRemoteStream: (stream: MediaStream) => {
        opts.log?.("remote stream", stream.getTracks().map((t) => t.kind));
        if (closed)
          return;
        opts.onRemoteStream(stream);
        if (stream.getVideoTracks().length > 0) {
          hasVideo = true;
          reportIfFlowing();
        }
      },
      onConnectionChange: onState,
      ...(opts.log && { onQueuePosition: (qp: unknown) => opts.log?.("queue position", qp) }),
      initialState: toLucyState(opts.input),
      // The heartbeat loop owns the session; one quick re-dial covers a blip at connect.
      retries: 1,
    } as any)
    .then((conn: any) => {
      if (closed) {
        conn.disconnect();
        return;
      }

      rt = conn;
      conn.on("error", (err: any) => {
        lastError = err?.message || err?.code || null;
        opts.log?.("provider error", lastError);
      });
      if (opts.log) {
        conn.on("diagnostic", (e: unknown) => opts.log?.("diagnostic", e));
        conn.on("generationEnded", (e: unknown) => opts.log?.("generation ended", e));
        // Every ~5th sample: enough to see whether frames go out and come back.
        let samples = 0;
        conn.on("stats", (s: unknown) => {
          if (samples++ % 5 === 0)
            opts.log?.("stats", s);
        });
      }
      // Deliberate server end (cap, moderation, balance, concurrency): no reconnect.
      conn.on("sessionEnded", ({ reason }: { reason: string }) => fail(new Error(`Live session ended: ${reason}`)));
    })
    .catch((err: any) => fail(err instanceof Error ? err : new Error(String(err))));

  return {
    send: (input) => {
      // Same shape the TryItOn apps send mid-stream.
      rt?.set({ prompt: input.prompt, image: input.referenceImage, enhance: input.enhancePrompt }).catch(() => {});
    },
    close: () => {
      if (closed)
        return;
      closed = true;
      clearTimeout(noVideoTimer);
      try {
        rt?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
};
