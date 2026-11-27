import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLiveTryOn } from "../src/session";
import { attachStream } from "../src/video";
import type { LiveApi } from "../src/api";
import type { MediaConnectOptions } from "../src/media";
import type { LiveStartResponse } from "../src/types";

// iOS Safari behaviours: hidden pages, cameras iOS has ended, and video that won't autoplay.

const start = {
  session: { id: "s1", status: "active", endReason: null, seconds: 0, creditsCharged: 0, endUserId: null },
  clientSecret: "secret-1",
  connection: { provider: "decart", model: "lucy-vton-latest", token: "tok" },
  secondsPerCredit: 2,
  maxSeconds: 180,
  secondsLeft: 20,
  garment: { id: "g1", category: "clothing", subcategory: "tops", description: null, input: { prompt: "p", enhancePrompt: true, referenceImage: "data:image/jpeg;base64,AA" } },
} as LiveStartResponse;

// Minimal event target with a settable visibilityState.
const fakeDocument = () => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    fire(type: string) {
      listeners.get(type)?.forEach((fn) => fn());
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
};

const cameraWith = (readyState: "live" | "ended") => {
  const stop = vi.fn();
  return { stream: { getVideoTracks: () => [{ readyState }], getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
};

describe("connectLiveTryOn on iOS", () => {
  let media: { opts: MediaConnectOptions } | undefined;
  let ends: unknown[];
  const api = () =>
    ({
      heartbeat: vi.fn(async () => ({ stop: false, secondsLeft: 18 })),
      switchGarment: vi.fn(),
      end: vi.fn(async (body: unknown) => {
        ends.push(body);
        return { id: "s1", status: "ended", endReason: "hidden", seconds: 0, creditsCharged: 0, endUserId: null };
      }),
      endOnUnload: vi.fn(),
    }) as unknown as LiveApi;
  const connect = (opts: object, deps: object) =>
    connectLiveTryOn(start, opts, {
      api: api(),
      connectMedia: (o: MediaConnectOptions) => {
        media = { opts: o };
        return { send: () => {}, close: () => {} };
      },
      pageEvents: null,
      now: () => Date.now(),
      ...deps,
    });

  beforeEach(() => {
    media = undefined;
    ends = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("ends the session when the page is hidden, and stops listening afterwards", async () => {
    const doc = fakeDocument();
    const fresh = cameraWith("live");
    const pending = connect({}, { visibility: doc, getCamera: async () => fresh.stream });
    await vi.waitFor(() => expect(media).toBeDefined());
    media!.opts.onConnected();
    const live = await pending;

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await vi.waitFor(() => expect(ends).toHaveLength(1));

    expect(live.status).toBe("ended");
    expect(ends[0]).toMatchObject({ reason: "hidden", connected: true });
    expect(doc.count("visibilitychange")).toBe(0);
  });

  it("keeps streaming while hidden with endWhenHidden: false", async () => {
    const doc = fakeDocument();
    const pending = connect({ endWhenHidden: false }, { visibility: doc, getCamera: async () => cameraWith("live").stream });
    await vi.waitFor(() => expect(media).toBeDefined());
    media!.opts.onConnected();
    const live = await pending;

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");

    expect(live.status).toBe("live");
    expect(ends).toHaveLength(0);
  });

  it("opens a fresh camera when the one passed in has an ended track, and stops it at the end", async () => {
    const dead = cameraWith("ended");
    const fresh = cameraWith("live");
    const getCamera = vi.fn(async () => fresh.stream);
    const pending = connect({ camera: dead.stream }, { visibility: null, getCamera });
    await vi.waitFor(() => expect(media).toBeDefined());

    expect(getCamera).toHaveBeenCalledTimes(1);
    expect(media!.opts.camera).toBe(fresh.stream);

    media!.opts.onConnected();
    const live = await pending;
    await live.end();
    expect(fresh.stop).toHaveBeenCalled();
    expect(dead.stop).not.toHaveBeenCalled();
  });

  it("uses a live camera that was passed in, and leaves it running (the caller owns it)", async () => {
    const own = cameraWith("live");
    const getCamera = vi.fn();
    const pending = connect({ camera: own.stream }, { visibility: null, getCamera });
    await vi.waitFor(() => expect(media).toBeDefined());

    expect(getCamera).not.toHaveBeenCalled();
    expect(media!.opts.camera).toBe(own.stream);

    media!.opts.onConnected();
    await (await pending).end();
    expect(own.stop).not.toHaveBeenCalled();
  });
});

describe("attachStream", () => {
  const fakeVideo = () => {
    const attrs: Record<string, string> = {};
    return {
      muted: false,
      playsInline: false,
      autoplay: false,
      paused: true,
      srcObject: null as unknown,
      setAttribute: (k: string, v: string) => (attrs[k] = v),
      attrs,
      play: vi.fn(async function (this: { paused: boolean }) {
        this.paused = false;
      }),
    };
  };

  it("sets the iOS inline attributes, plays, and resumes when the page is shown again", async () => {
    const video = fakeVideo();
    const doc = fakeDocument();
    const win = fakeDocument();
    const stream = {} as MediaStream;

    const detach = attachStream(video as unknown as HTMLVideoElement, stream, { document: doc, window: win });

    expect(video).toMatchObject({ muted: true, playsInline: true, autoplay: true, srcObject: stream });
    expect(video.attrs.playsinline).toBe("");
    expect(video.play).toHaveBeenCalledTimes(1);

    // iOS paused it in the background; back on the page it plays again.
    video.paused = true;
    doc.fire("visibilitychange");
    video.paused = true;
    win.fire("pageshow");
    expect(video.play).toHaveBeenCalledTimes(3);

    // Already playing: nothing to resume.
    doc.fire("visibilitychange");
    expect(video.play).toHaveBeenCalledTimes(3);

    detach();
    expect(doc.count("visibilitychange") + win.count("pageshow")).toBe(0);
  });

  it("doesn't try to play while the page is hidden", () => {
    const video = fakeVideo();
    const doc = fakeDocument();
    doc.visibilityState = "hidden";

    attachStream(video as unknown as HTMLVideoElement, {} as MediaStream, { document: doc, window: null });

    expect(video.play).not.toHaveBeenCalled();
  });
});
