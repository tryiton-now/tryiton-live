import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake Decart realtime client: the test drives connection states and the remote stream.
let connectOpts: any;
vi.mock("@decartai/sdk", () => ({
  createConsoleLogger: () => ({}),
  models: { realtime: (name: string) => ({ name }) },
  createDecartClient: () => ({
    realtime: {
      connect: async (_camera: unknown, opts: unknown) => {
        connectOpts = opts;
        return { on: () => {}, set: async () => {}, disconnect: () => {} };
      },
    },
  }),
}));

const { connectDecart } = await import("../src/media");

// A remote video track that is `muted` until its first frame arrives, like a browser's.
const mutedTrack = () => {
  const listeners = new Set<() => void>();
  return {
    kind: "video",
    muted: true,
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    firstFrame() {
      this.muted = false;
      [...listeners].forEach((fn) => fn());
    },
  };
};

const stream = (kinds: string[], video: any = null) =>
  ({
    getTracks: () => kinds.map((kind) => ({ kind })),
    getVideoTracks: () => (video ? [video] : kinds.filter((k) => k === "video").map((kind) => ({ kind }))),
  }) as unknown as MediaStream;

const open = (extra = {}) => {
  const calls = { connected: 0, failures: [] as string[] };
  connectDecart({
    provider: "decart",
    model: "lucy-vton-latest",
    token: "tok",
    camera: {} as MediaStream,
    input: { prompt: "p", enhancePrompt: true, referenceImage: "data:image/jpeg;base64,AA" },
    onRemoteStream: () => {},
    onConnected: () => calls.connected++,
    onFailure: (e) => calls.failures.push(e.message),
    ...extra,
  });
  return calls;
};

beforeEach(() => {
  connectOpts = undefined;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("connectDecart", () => {
  it("does not report connected (start billing) on the provider's 'connected' alone", async () => {
    const calls = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());

    connectOpts.onConnectionChange("connected");

    expect(calls.connected).toBe(0);
  });

  it("reports connected once both the session and an edited video track are there, in either order", async () => {
    const a = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    connectOpts.onConnectionChange("connected");
    connectOpts.onRemoteStream(stream(["video"]));
    expect(a.connected).toBe(1);

    connectOpts = undefined;
    const b = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    connectOpts.onRemoteStream(stream(["video"]));
    connectOpts.onConnectionChange("generating");
    connectOpts.onConnectionChange("connected");
    expect(b.connected).toBe(1);
  });

  it("waits for the first frame of a track that arrives empty before reporting connected", async () => {
    const calls = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    const track = mutedTrack();

    connectOpts.onConnectionChange("connected");
    connectOpts.onRemoteStream(stream(["video"], track));
    expect(calls.connected).toBe(0);

    track.firstFrame();
    expect(calls.connected).toBe(1);
  });

  it("a re-dial before the first frame ignores the dead attempt's track", async () => {
    const calls = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    const dead = mutedTrack();

    connectOpts.onConnectionChange("connected");
    connectOpts.onRemoteStream(stream(["video"], dead));
    connectOpts.onConnectionChange("reconnecting");
    dead.firstFrame();
    expect(calls.connected).toBe(0);

    const fresh = mutedTrack();
    connectOpts.onRemoteStream(stream(["video"], fresh));
    connectOpts.onConnectionChange("connected");
    fresh.firstFrame();
    expect(calls.connected).toBe(1);
  });

  it("ignores an audio-only remote stream", async () => {
    const calls = open();
    await vi.waitFor(() => expect(connectOpts).toBeDefined());

    connectOpts.onConnectionChange("connected");
    connectOpts.onRemoteStream(stream(["audio"]));

    expect(calls.connected).toBe(0);
  });

  it("fails when no try-on video arrives in time", async () => {
    const calls = open({ connectTimeoutMs: 5000 });
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    connectOpts.onConnectionChange("connected");

    await vi.advanceTimersByTimeAsync(5000);

    expect(calls.connected).toBe(0);
    expect(calls.failures).toEqual(["No video from the live service. Please try again."]);
  });

  it("does not time out a session that went live", async () => {
    const calls = open({ connectTimeoutMs: 5000 });
    await vi.waitFor(() => expect(connectOpts).toBeDefined());
    connectOpts.onConnectionChange("connected");
    connectOpts.onRemoteStream(stream(["video"]));

    await vi.advanceTimersByTimeAsync(60000);

    expect(calls.failures).toEqual([]);
  });
});
