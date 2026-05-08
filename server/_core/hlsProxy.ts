import type { Express } from "express";
import http from "http";
import https from "https";

// On Windows Docker, host.docker.internal resolves to the host machine
// This allows the app container to reach MediaMTX exposed on localhost:8888
const MEDIAMTX_URL = process.env.MEDIAMTX_INTERNAL_URL || "http://host.docker.internal:8888";

export function registerHlsProxy(app: Express) {
  // Proxy all /hls-proxy/* requests to MediaMTX
  // This avoids CORS issues when the browser requests HLS segments from a different port
  app.use("/hls-proxy", (req, res) => {
    const targetUrl = `${MEDIAMTX_URL}${req.path}${req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : ""}`;

    const client = targetUrl.startsWith("https") ? https : http;

    const proxyReq = client.get(targetUrl, (proxyRes) => {
      // Copy status & headers, add CORS
      res.status(proxyRes.statusCode || 200);
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

      // Forward content-type header for m3u8/ts segments
      if (proxyRes.headers["content-type"]) {
        res.set("Content-Type", proxyRes.headers["content-type"]);
      }
      if (proxyRes.headers["content-length"]) {
        res.set("Content-Length", proxyRes.headers["content-length"]);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("[HlsProxy] Error proxying to MediaMTX:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "HLS proxy error", detail: err.message });
      }
    });

    req.on("close", () => proxyReq.destroy());
  });
}
