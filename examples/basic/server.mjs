// Minimal integrator backend for the live try-on demo. It holds the API key (the browser never sees it),
// prepares garments and starts sessions, then hands the start response to the page. No dependencies.
//
//   TRYITON_API_KEY=... node examples/basic/server.mjs
//   open http://localhost:5173
//
// TRYITON_API_BASE defaults to production (https://tryiton.now/api/v1).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_KEY = process.env.TRYITON_API_KEY;
const API_BASE = (process.env.TRYITON_API_BASE || "https://tryiton.now/api/v1").replace(/\/+$/, "");
const PORT = Number(process.env.PORT) || 5173;
const ROOT = fileURLToPath(new URL(".", import.meta.url));

if (!API_KEY) {
  console.error("Set TRYITON_API_KEY.");
  process.exit(1);
}

const tryiton = async (method, path, body) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, ...(body && { "Content-Type": "application/json" }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

const readJson = async (req) => {
  let raw = "";
  for await (const chunk of req)
    raw += chunk;
  // Garment photos arrive as data URIs; cap well above a phone photo.
  if (raw.length > 15 * 1024 * 1024)
    throw new Error("Image too large.");
  return raw ? JSON.parse(raw) : {};
};

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const TYPES = { ".html": "text/html", ".js": "text/javascript" };

createServer(async (req, res) => {
  try {
    // Prepare a garment (do this at catalog sync in a real integration; it's cached per image).
    if (req.method === "POST" && req.url === "/demo/garments") {
      const { image } = await readJson(req);
      const r = await tryiton("POST", "/live/garments", { garment_image: image });
      return send(res, r.status, r.json);
    }

    // Start a session for this visitor and pass the response straight to the browser SDK.
    if (req.method === "POST" && req.url === "/demo/sessions") {
      const { garmentId } = await readJson(req);
      const r = await tryiton("POST", "/live/sessions", {
        garment_id: garmentId,
        end_user_id: "demo-visitor",
        // Optional cap for testing (LIVE_MAX_SECONDS=20); the account's default otherwise.
        ...(process.env.LIVE_MAX_SECONDS && { max_seconds: Number(process.env.LIVE_MAX_SECONDS) }),
        // Locks the media token to this page's origin (LOCK_ORIGIN=false to skip, for debugging).
        ...(process.env.LOCK_ORIGIN !== "false" && { allowed_origin: req.headers.origin || `http://localhost:${PORT}` }),
      });
      return send(res, r.status, r.json);
    }

    if (req.method === "GET") {
      const pathname = req.url.split("?")[0];
      const path = pathname === "/" ? "/index.html" : pathname;
      if (!/^\/(index\.html|vendor\/(tryiton-live|frame-metadata-worker)\.js)$/.test(path))
        return send(res, 404, { ok: false });
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
      return res.end(path === "/index.html" ? body.toString().replace("__API_BASE__", API_BASE) : body);
    }

    send(res, 404, { ok: false });
  } catch (err) {
    send(res, 500, { ok: false, error: { message: err.message } });
  }
}).listen(PORT, () => console.log(`Live try-on demo on http://localhost:${PORT} (API: ${API_BASE})`));
