import type { Express } from "express";
import http from "http";
import https from "https";

const MEDIAMTX_URL     = process.env.MEDIAMTX_INTERNAL_URL || "http://host.docker.internal:8888";
const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL    || "http://localhost:4253";

function makeProxy(label: string, baseUrl: string) {
  return (req: any, res: any) => {
    const targetUrl = `${baseUrl}${req.path}${req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : ""}`;
    const client = targetUrl.startsWith("https") ? https : http;
    const proxyReq = client.get(targetUrl, (proxyRes) => {
      res.status(proxyRes.statusCode || 200);
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      if (proxyRes.headers["content-type"])   res.set("Content-Type",   proxyRes.headers["content-type"]);
      if (proxyRes.headers["content-length"]) res.set("Content-Length", proxyRes.headers["content-length"]);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", (err) => {
      console.error(`[HlsProxy][${label}] Error:`, err.message);
      if (!res.headersSent) res.status(502).json({ error: "HLS proxy error", detail: err.message });
    });
    req.on("close", () => proxyReq.destroy());
  };
}

export function registerHlsProxy(app: Express) {
  app.use("/hls-proxy",   makeProxy("mediamtx",     MEDIAMTX_URL));
  app.use("/stream-hls",  makeProxy("stream-server", STREAM_SERVER_URL));
}
