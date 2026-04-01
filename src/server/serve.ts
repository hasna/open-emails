/**
 * HTTP server for the emails dashboard.
 * Provides REST API and serves the static dashboard from dashboard/index.html.
 *
 * API route logic lives in api-routes.ts to keep this file thin.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { handleApiRequest } from "./api-routes.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveDashboardDir(): string {
  const candidates: string[] = [];

  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(scriptDir, "..", "dashboard"));
    candidates.push(join(scriptDir, "..", "..", "dashboard"));
  } catch {
    // import.meta.url may not be available in all contexts
  }

  if (process.argv[1]) {
    const mainDir = dirname(process.argv[1]);
    candidates.push(join(mainDir, "..", "dashboard"));
    candidates.push(join(mainDir, "..", "..", "dashboard"));
  }

  candidates.push(join(process.cwd(), "dashboard"));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }

  return join(process.cwd(), "dashboard");
}

export async function startServer(port = 3900, hostname = "127.0.0.1"): Promise<void> {
  const dashboardDir = resolveDashboardDir();

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // ─── CORS preflight ────────────────────────────────────────────────────
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // ─── API ROUTES ────────────────────────────────────────────────────────
      if (path.startsWith("/api/") || path.startsWith("/track/") || path.startsWith("/webhook/") || path.startsWith("/open/") || path.startsWith("/click/")) {
        const apiResponse = await handleApiRequest(req, url, path, method);
        if (apiResponse !== null) return apiResponse;
      }

      // ─── STATIC DASHBOARD ────────────────────────────────────────────────
      if (method === "GET") {
        let filePath: string;
        if (path === "/" || path === "/index.html") {
          filePath = join(dashboardDir, "index.html");
        } else {
          filePath = join(dashboardDir, path.slice(1));
        }

        if (existsSync(filePath)) {
          const ext = extname(filePath);
          const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(readFileSync(filePath), {
            headers: { "Content-Type": mimeType },
          });
        }

        // SPA fallback
        const indexPath = join(dashboardDir, "index.html");
        if (existsSync(indexPath)) {
          return new Response(readFileSync(indexPath), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    },
  });

  console.log(`\nEmails dashboard running at http://${hostname}:${server.port}`);
  console.log(`API available at http://${hostname}:${server.port}/api`);
  console.log(`Press Ctrl+C to stop\n`);
}
