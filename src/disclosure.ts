// Visible AI disclosure over the try-on video. EU AI Act Art. 50(4): whoever shows AI-altered video of a person to
// users has to make that clear. A small frosted label in a corner of your video container, plain DOM, no styles needed.

export type AiDisclosurePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface AiDisclosureOptions {
  /** Default "AI-modified video". Localize it, but keep it saying the video is AI-modified. */
  label?: string;
  /** Default "bottom-left". */
  position?: AiDisclosurePosition;
  /** Gap to the container's edges in px. Default 12. */
  inset?: number;
}

export const DEFAULT_AI_DISCLOSURE_LABEL = "AI-modified video";

/**
 * Show the AI-disclosure label over `container` (the element that holds your try-on `<video>`). A statically
 * positioned container becomes `position: relative` so the label can sit in its corner.
 * @returns a function that removes the label (and restores the container's position)
 */
export function showAiDisclosure(container: HTMLElement, opts: AiDisclosureOptions = {}): () => void {
  const { label = DEFAULT_AI_DISCLOSURE_LABEL, position = "bottom-left", inset = 12 } = opts;
  const doc = container.ownerDocument;
  const view = doc.defaultView;

  const restorePosition = view && view.getComputedStyle(container).position === "static" ? container.style.position : null;
  if (restorePosition !== null)
    container.style.position = "relative";

  const el = doc.createElement("div");
  el.textContent = label;
  el.setAttribute("data-tryiton-ai-disclosure", "");
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "right"];
  Object.assign(el.style, {
    position: "absolute",
    [vertical]: `${inset}px`,
    [horizontal]: `${inset}px`,
    zIndex: "2147483000",
    padding: "6px 12px",
    borderRadius: "999px",
    font: "500 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif",
    letterSpacing: "0.02em",
    color: "#fff",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    userSelect: "none",
    background: "linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.12))",
    border: "1px solid rgba(255,255,255,0.28)",
    boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
    backdropFilter: "blur(10px) saturate(1.2)",
    webkitBackdropFilter: "blur(10px) saturate(1.2)",
  } as Partial<CSSStyleDeclaration>);
  container.appendChild(el);

  let removed = false;
  return () => {
    if (removed)
      return;
    removed = true;
    el.remove();
    if (restorePosition !== null)
      container.style.position = restorePosition;
  };
}
