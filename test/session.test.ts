import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLiveTryOn } from "../src/session";
import { createLiveApi } from "../src/api";
import type { LiveApi } from "../src/api";
import type { MediaConnectOptions } from "../src/media";
import type { LiveStartResponse } from "../src/types";

const INPUT = { prompt: "a blue shirt", enhancePrompt: true, referenceImage: "data:image/jpeg;base64,AA" };

const startResponse = (extra: Partial<LiveStartResponse> = {}): LiveStartResponse => ({
  session: { id: "s1", status: "active", endReason: null, seconds: 0, creditsCharged: 0, endUserId: null },
  clientSecret: "secret-1",
  connection: { provider: "decart", model: "lucy-vton-latest", token: "tok" },
  secondsPerCredit: 2,
  maxSeconds: 180,
  secondsLeft: 20,
  garment: { id: "g1", category: "clothing", subcategory: "tops", description: null, input: INPUT },
  ...extra,
});

// Fake media provider: the test decides when it connects or fails.
let media: { opts: MediaConnectOptions; sent: unknown[]; closed: boolean } | undefined;
const connectMedia = (opts: MediaConnectOptions) => {
  media = { opts, sent: [], closed: false };
  return { send: (i: unknown) => media.sent.push(i), close: () => (media.closed = true) };
};

const fakeApi = (overrides: Partial<LiveApi> = {}) => {
  const calls = { heartbeat: 0, end: [] as unknown[], unload: [] as unknown[] };
  const api: LiveApi = {
    heartbeat: vi.fn(async () => {
      calls.heartbeat++;
      return { stop: false, secondsLeft: 18 };
    }),
    switchGarment: vi.fn(async (id: string) => ({ id, category: "clothing", subcategory: "tops", description: null, input: { ...INPUT, prompt: id } })),
    end: vi.fn(async (body) => {
      calls.end.push(body);
      return { id: "s1", status: "ended" as const, endReason: (body as any).reason, seconds: 4, creditsCharged: 2, endUserId: null };
    }),
    endOnUnload: vi.fn((body) => void calls.unload.push(body)),
    ...overrides,
  };
  return { api, calls };
};

const camera = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;

const connect = (api: LiveApi, opts = {}, start = startResponse(), pageEvents: any = null) =>
  connectLiveTryOn(start, opts, { api, connectMedia, getCamera: async () => camera(), pageEvents, now: () => Date.now() });

beforeEach(() => {
  media = undefined;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("connectLiveTryOn", () => {
  it("resolves once media flows and starts heartbeats on the billing cadence", async () => {
    const { api, calls } = fakeApi();
    const statuses: string[] = [];
    const pending = connect(api, { onStatusChange: (s: string) => statuses.push(s) });
    await vi.waitFor(() => expect(media).toBeDefined());
    expect(media.opts.input).toEqual(INPUT);
    expect(media.opts.token).toBe("tok");

    media.opts.onConnected();
    const live = await pending;
    expect(live.status).toBe("live");
    expect(statuses).toEqual(["live"]);

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.heartbeat).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.heartbeat).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.heartbeat).toBe(2);
    expect(live.secondsLeft).toBe(18);
  });

  it("names the next tick in each heartbeat, following the server's count after a retry", async () => {
    const seqs: number[] = [];
    let attempt = 0;
    const { api } = fakeApi({
      heartbeat: vi.fn(async (_ms: number | null, seq: number) => {
        seqs.push(seq);
        attempt++;
        // The 2nd request times out client-side although the server settled tick 2.
        if (attempt === 2)
          throw new Error("timeout");
        return { stop: false, secondsLeft: 18, ticks: attempt === 3 ? 2 : seq };
      }),
    });
    const pending = connect(api);
    await vi.waitFor(() => expect(media).toBeDefined());
    media!.opts.onConnected();
    await pending;

    await vi.advanceTimersByTimeAsync(2000); // tick 1
    await vi.advanceTimersByTimeAsync(2000); // tick 2 fails
    await vi.advanceTimersByTimeAsync(2000); // retry of tick 2: server says already 2 settled
    await vi.advanceTimersByTimeAsync(2000); // tick 3

    expect(seqs.slice(0, 4)).toEqual([1, 2, 2, 3]);
  });

  it("ends without calling /end when a heartbeat says stop", async () => {
    const summary = { id: "s1", status: "ended" as const, endReason: "out_of_credits", seconds: 6, creditsCharged: 3, endUserId: null };
    const { api, calls } = fakeApi({ heartbeat: vi.fn(async () => ({ stop: true, reason: "out_of_credits", session: summary })) });
    const onEnd = vi.fn();
    const pending = connect(api, { onEnd });
    await vi.waitFor(() => expect(media).toBeDefined());
    media.opts.onConnected();
    const live = await pending;

    await vi.advanceTimersByTimeAsync(2000);

    expect(live.status).toBe("ended");
    expect(media.closed).toBe(true);
    expect(calls.end).toHaveLength(0);
    expect(onEnd).toHaveBeenCalledWith({ reason: "out_of_credits", session: summary, error: null });
  });

  it("never streams unbilled: two failed heartbeats end the session", async () => {
    const { api, calls } = fakeApi({ heartbeat: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const onEnd = vi.fn();
    const pending = connect(api, { onEnd });
    await vi.waitFor(() => expect(media).toBeDefined());
    media.opts.onConnected();
    await pending;

    await vi.advanceTimersByTimeAsync(2000); // first failure → retry in 2 s
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); // second failure → end

    expect(media.closed).toBe(true);
    expect((calls.end[0] as any).reason).toBe("error");
    expect(onEnd.mock.calls[0][0].error.code).toBe("heartbeat_failed");
  });

  it("switches garments on the running stream", async () => {
    const { api } = fakeApi();
    const pending = connect(api);
    await vi.waitFor(() => expect(media).toBeDefined());
    media.opts.onConnected();
    const live = await pending;

    const garment = await live.switchGarment("g2");

    expect(api.switchGarment).toHaveBeenCalledWith("g2");
    expect(garment.id).toBe("g2");
    expect(media.sent).toEqual([{ ...INPUT, prompt: "g2" }]);
  });

  it("end() is idempotent and reports usage", async () => {
    const { api, calls } = fakeApi();
    const pending = connect(api);
    await vi.waitFor(() => expect(media).toBeDefined());
    media.opts.onConnected();
    const live = await pending;

    const [a, b] = await Promise.all([live.end(), live.end()]);

    expect(a).toBe(b);
    expect(calls.end).toHaveLength(1);
    expect(calls.end[0]).toMatchObject({ reason: "user", connected: true });
    expect(a.session?.creditsCharged).toBe(2);
  });

  it("a connect failure rejects and ends the session as never streamed", async () => {
    const { api, calls } = fakeApi();
    const pending = connect(api);
    await vi.waitFor(() => expect(media).toBeDefined());

    media.opts.onFailure(new Error("Session limit reached"), { busy: true });

    await expect(pending).rejects.toMatchObject({ code: "busy" });
    expect(calls.end[0]).toMatchObject({ reason: "error", connected: false });
  });

  it("fetches the first garment when the start response has none", async () => {
    const { api } = fakeApi();
    const pending = connect(api, { garmentId: "g9" }, startResponse({ garment: null }));
    await vi.waitFor(() => expect(media).toBeDefined());

    expect(api.switchGarment).toHaveBeenCalledWith("g9");
    expect(media.opts.input.prompt).toBe("g9");
    media.opts.onConnected();
    await pending;
  });

  it("without any garment it rejects before opening the camera and frees the session", async () => {
    const { api, calls } = fakeApi();

    await expect(connect(api, {}, startResponse({ garment: null }))).rejects.toMatchObject({ code: "garment_required" });
    expect(calls.end[0]).toMatchObject({ reason: "error", connected: false });
  });

  it("ends with a keepalive request when the page is hidden for good", async () => {
    const listeners: Record<string, () => void> = {};
    const pageEvents = { addEventListener: (t: string, fn: () => void) => (listeners[t] = fn), removeEventListener: vi.fn() };
    const { api, calls } = fakeApi();
    const onEnd = vi.fn();
    const pending = connect(api, { onEnd }, startResponse(), pageEvents);
    await vi.waitFor(() => expect(media).toBeDefined());
    media.opts.onConnected();
    await pending;

    listeners.pagehide();

    expect(calls.unload[0]).toMatchObject({ reason: "unload", connected: true });
    expect(calls.end).toHaveLength(0);
    expect(media.closed).toBe(true);
    expect(onEnd).toHaveBeenCalledWith({ reason: "unload", session: null, error: null });
  });

  it("rejects a start response without session credentials", () => {
    const { api } = fakeApi();
    expect(() => connect(api, {}, { session: { id: "s1" } } as any)).toThrow(TypeError);
  });
});

describe("createLiveApi", () => {
  it("sends the client secret (never an API key) and maps backend errors", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { name: "NotFound", message: "Session not found." } }), { status: 404 }));
    const api = createLiveApi({ baseUrl: "https://api.test/api/v1/", sessionId: "s1", secret: "sec", fetchFn });

    await expect(api.heartbeat(900, 3)).rejects.toMatchObject({ code: "http_error", status: 404, apiName: "NotFound" });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/live/sessions/s1/heartbeat");
    expect(JSON.parse(init.body as string)).toEqual({ seq: 3, connect_ms: 900, secret: "sec" });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("unload end is a CORS-simple keepalive request with the secret in the URL", () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    const api = createLiveApi({ baseUrl: "https://api.test/api/v1", sessionId: "s1", secret: "s e c", fetchFn });

    api.endOnUnload({ reason: "unload", connected: true });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/live/sessions/s1/end?secret=s%20e%20c");
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
  });
});
