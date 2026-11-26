import { TryItOnLiveError } from "./errors";
import type { LiveGarment, LiveSessionSummary } from "./types";

// Device-side calls to /api/v1/live/sessions/:id/*, authenticated by the session's client secret (never the
// API key). Plain fetch, no credentials/cookies.

export const DEFAULT_API_BASE_URL = "https://tryiton.now/api/v1";

export interface HeartbeatResult {
  stop: boolean;
  reason?: string;
  secondsLeft?: number;
  /** Ticks the server has settled so far; the next heartbeat settles `ticks + 1`. */
  ticks?: number;
  session?: LiveSessionSummary;
}

export interface EndBody {
  reason: string;
  connected: boolean;
  connect_ms?: number;
  error?: string;
}

export interface LiveApi {
  /** `seq` = the 1-based tick being settled; a repeat (retry) is answered without a second charge. */
  heartbeat(connectMs: number | null, seq: number): Promise<HeartbeatResult>;
  switchGarment(garmentId: string): Promise<LiveGarment>;
  end(body: EndBody): Promise<LiveSessionSummary | null>;
  /** Fire-and-forget end for a dying page: a CORS-simple request (no preflight) with the secret in the URL. */
  endOnUnload(body: EndBody): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createLiveApi({
  baseUrl,
  sessionId,
  secret,
  fetchFn = (url, init) => fetch(url, init),
}: {
  baseUrl: string;
  sessionId: string;
  secret: string;
  fetchFn?: FetchLike;
}): LiveApi {
  const root = `${baseUrl.replace(/\/+$/, "")}/live/sessions/${encodeURIComponent(sessionId)}`;

  const post = async <T>(path: string, body: object): Promise<T> => {
    const res = await fetchFn(`${root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, secret }),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.ok)
      throw new TryItOnLiveError("http_error", json?.error?.message || `Request failed with status ${res.status}`, {
        status: res.status,
        apiName: json?.error?.name || null,
      });

    return json as T;
  };

  return {
    heartbeat: async (connectMs, seq) => {
      const { stop, reason, secondsLeft, ticks, session } = await post<HeartbeatResult>("/heartbeat", {
        seq,
        ...(connectMs != null && { connect_ms: connectMs }),
      });
      return { stop, reason, secondsLeft, ticks, session };
    },
    switchGarment: async (garmentId) => (await post<{ garment: LiveGarment }>(`/garments/${encodeURIComponent(garmentId)}`, {})).garment,
    end: async (body) => (await post<{ session: LiveSessionSummary }>("/end", body)).session || null,
    endOnUnload: (body) => {
      try {
        void fetchFn(`${root}/end?secret=${encodeURIComponent(secret)}`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(body),
        }).catch(() => {});
      } catch {
        // Best-effort: the server's stale-session sweeper settles it anyway.
      }
    },
  };
}
