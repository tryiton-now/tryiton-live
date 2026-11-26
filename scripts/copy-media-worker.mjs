// Copies @decartai/sdk's frame worker next to an esbuild bundle. On Chromium the media SDK pipes every outgoing
// encoded frame through this worker, loaded via `new URL("./frame-metadata-worker.js", import.meta.url)`.
// webpack 5 / Vite / Next emit it automatically; esbuild doesn't, and without it no video leaves the browser.
//
//   node scripts/copy-media-worker.mjs <bundle output dir>
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/copy-media-worker.mjs <bundle output dir>");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve("@decartai/sdk"));
const worker = join(sdkDist, "realtime", "browser", "frame-metadata-worker.js");
copyFileSync(worker, join(outDir, "frame-metadata-worker.js"));
console.log(`copied frame-metadata-worker.js → ${outDir}`);
