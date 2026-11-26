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

const stream = (kinds: string[]) =>
  ({ getTracks: () => kinds.map((kind) => ({ kind })), getVideoTracks: () => kinds.filter((k) => k === "video").map((kind) => ({ kind })) }) as unknown as MediaStream;

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
