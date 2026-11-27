// Show the try-on stream in a <video> so it actually plays everywhere, iOS Safari included.

export interface AttachStreamOptions {
  /** The document, for resuming playback when the page is shown again. Default: the element's own document. */
  document?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  /** The window, for `pageshow` (back/forward cache). Default: the document's window. */
  window?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

/**
 * Play `stream` in `video` and keep it playing. Sets `muted` and `playsinline` (iOS plays inline video only when
 * muted and inline) and calls `play()` itself, because iOS ignores `autoplay` in Low Power Mode and pauses media while
 * the page is hidden. Playback resumes when the page is visible again. Call it from `onStream`.
 * @returns a function that stops watching the page (the video keeps its stream)
 * @example connectLiveTryOn(start, { onStream: (s) => attachStream(video, s) });
 */
export function attachStream(video: HTMLVideoElement, stream: MediaStream, opts: AttachStreamOptions = {}): () => void {
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.autoplay = true;
  if (video.srcObject !== stream)
    video.srcObject = stream;

  const doc = opts.document ?? video.ownerDocument;
  const win = opts.window !== undefined ? opts.window : (video.ownerDocument?.defaultView ?? null);
  const resume = () => {
    if (video.paused && doc?.visibilityState !== "hidden")
      video.play().catch(() => {});
  };
  resume();
  doc?.addEventListener("visibilitychange", resume);
  win?.addEventListener("pageshow", resume);

  return () => {
    doc?.removeEventListener("visibilitychange", resume);
    win?.removeEventListener("pageshow", resume);
  };
}
