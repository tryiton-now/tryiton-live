import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_DISCLOSURE_LABEL, showAiDisclosure } from "../src/disclosure";
import { connectLiveTryOn } from "../src/session";
import type { LiveApi } from "../src/api";
import type { MediaConnectOptions } from "../src/media";
import type { LiveStartResponse } from "../src/types";

// Minimal DOM stand-in (tests run in node): what showAiDisclosure touches.
const fakeElement = () => ({ textContent: "", style: {} as Record<string, string>, attrs: {} as Record<string, string>, removed: false,
  setAttribute(k: string, v: string) { this.attrs[k] = v; },
  remove() { this.removed = true; },
});
const fakeContainer = (position = "static") => {
  const children: any[] = [];
  const container: any = {
    style: { position: "" },
    children,
    appendChild: (el: any) => children.push(el),
    ownerDocument: {
      createElement: () => fakeElement(),
      defaultView: { getComputedStyle: () => ({ position }) },
    },
  };
  return container;
};

describe("showAiDisclosure", () => {
  it("puts the label in the container's corner and removes it again", () => {
    const container = fakeContainer();
    const remove = showAiDisclosure(container, { position: "top-right", inset: 8 });
    const label = container.children[0];

    expect(label.textContent).toBe(DEFAULT_AI_DISCLOSURE_LABEL);
    expect(label.style).toMatchObject({ position: "absolute", top: "8px", right: "8px", pointerEvents: "none" });
    // A static container is made relative for the corner, and restored after.
    expect(container.style.position).toBe("relative");

    remove();
    remove();
    expect(label.removed).toBe(true);
    expect(container.style.position).toBe("");
  });

  it("leaves a positioned container alone and takes a custom label", () => {
    const container = fakeContainer("absolute");
    showAiDisclosure(container, { label: "KI-veränderte Vorschau" });

    expect(container.style.position).toBe("");
    expect(container.children[0].textContent).toBe("KI-veränderte Vorschau");
    expect(container.children[0].style).toMatchObject({ bottom: "12px", left: "12px" });
  });
});

describe("connectLiveTryOn({ disclosure })", () => {
  let media: { opts: MediaConnectOptions } | undefined;
  const start: LiveStartResponse = {
    session: { id: "s1", status: "active", endReason: null, seconds: 0, creditsCharged: 0, endUserId: null },
    clientSecret: "secret-1",
    connection: { provider: "decart", model: "lucy-vton-latest", token: "tok" },
    secondsPerCredit: 2,
    maxSeconds: 180,
    secondsLeft: 20,
    garment: { id: "g1", category: "clothing", subcategory: "tops", description: null, input: { prompt: "p", enhancePrompt: true, referenceImage: "data:image/jpeg;base64,AA" } },
  } as LiveStartResponse;
  const api = {
    heartbeat: vi.fn(async () => ({ stop: false, secondsLeft: 18 })),
    switchGarment: vi.fn(),
    end: vi.fn(async () => ({ id: "s1", status: "ended", endReason: "user", seconds: 2, creditsCharged: 1, endUserId: null })),
    endOnUnload: vi.fn(),
  } as unknown as LiveApi;
  const deps = () => ({
    api,
    connectMedia: (opts: MediaConnectOptions) => {
      media = { opts };
      return { send: () => {}, close: () => {} };
    },
    getCamera: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
    pageEvents: null,
    now: () => Date.now(),
  });

  beforeEach(() => {
    media = undefined;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("shows the label only while edited video is live", async () => {
    const container = fakeContainer();
    const pending = connectLiveTryOn(start, { disclosure: { container, label: "AI preview" } }, deps());
    await vi.waitFor(() => expect(media).toBeDefined());
    expect(container.children).toHaveLength(0); // not before frames flow

    media!.opts.onConnected();
    const live = await pending;
    expect(container.children[0].textContent).toBe("AI preview");

    await live.end();
    expect(container.children[0].removed).toBe(true);
  });
});
