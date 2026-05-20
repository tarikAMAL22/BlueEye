import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  // Inline minimal config — avoids importing vite.config.ts with platform-specific plugins
  const vite = await createViteServer({
    configFile: false,
    root: path.resolve(PROJECT_ROOT, "client"),
    publicDir: path.resolve(PROJECT_ROOT, "client", "public"),
    envDir: PROJECT_ROOT,
    plugins: [
      (await import("@vitejs/plugin-react")).default(),
      (await import("@tailwindcss/vite")).default(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(PROJECT_ROOT, "client", "src"),
        "@shared": path.resolve(PROJECT_ROOT, "shared"),
        "@assets": path.resolve(PROJECT_ROOT, "attached_assets"),
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path.resolve(PROJECT_ROOT, "client", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      template = template.replace(/%VITE_ANALYTICS_ENDPOINT%/g, process.env.VITE_ANALYTICS_ENDPOINT || "");
      template = template.replace(/%VITE_ANALYTICS_WEBSITE_ID%/g, process.env.VITE_ANALYTICS_WEBSITE_ID || "");
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(PROJECT_ROOT, "dist", "public");
  if (!fs.existsSync(distPath)) {
    console.error(`Build directory not found: ${distPath}. Run pnpm build first.`);
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
