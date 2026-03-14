/**
 * HTTP server for the emails dashboard.
 * Provides REST API and serves the static dashboard from dashboard/index.html.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { createProvider, listProviders, deleteProvider, getProvider, updateProvider } from "../db/providers.js";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress, listAddresses, deleteAddress } from "../db/addresses.js";
import { listEmails, getEmail, searchEmails } from "../db/emails.js";
import { listEvents } from "../db/events.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

function internalError(e: unknown): Response {
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

function resolveId(table: string, partialId: string): string | null {
  const db = getDatabase();
  return resolvePartialId(db, table, partialId);
}

const CREDENTIAL_FIELDS = ["api_key", "secret_key", "access_key", "oauth_client_secret", "oauth_refresh_token", "oauth_access_token"] as const;

function sanitizeProvider(provider: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...provider };
  for (const field of CREDENTIAL_FIELDS) {
    if (sanitized[field]) sanitized[field] = "***";
  }
  return sanitized;
}

async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export async function startServer(port = 3900): Promise<void> {
  const dashboardDir = resolveDashboardDir();

  const server = Bun.serve({
    port,
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

      // GET /api/providers
      if (path === "/api/providers" && method === "GET") {
        try {
          return json(listProviders().map(p => sanitizeProvider(p as unknown as Record<string, unknown>)));
        } catch (e) { return internalError(e); }
      }

      // POST /api/providers
      if (path === "/api/providers" && method === "POST") {
        try {
          const body = await parseBody(req) as Record<string, unknown>;
          const provider = createProvider({
            name: String(body.name ?? ""),
            type: (body.type as "resend" | "ses" | "gmail") ?? "resend",
            api_key: body.api_key as string | undefined,
            region: body.region as string | undefined,
            access_key: body.access_key as string | undefined,
            secret_key: body.secret_key as string | undefined,
            oauth_client_id: body.oauth_client_id as string | undefined,
            oauth_client_secret: body.oauth_client_secret as string | undefined,
            oauth_refresh_token: body.oauth_refresh_token as string | undefined,
            oauth_access_token: body.oauth_access_token as string | undefined,
            oauth_token_expiry: body.oauth_token_expiry as string | undefined,
          });
          return json(sanitizeProvider(provider as unknown as Record<string, unknown>), 201);
        } catch (e) { return internalError(e); }
      }

      // PUT /api/providers/:id
      const providerPutMatch = path.match(/^\/api\/providers\/([^/]+)$/);
      if (providerPutMatch && method === "PUT") {
        const id = resolveId("providers", providerPutMatch[1]!);
        if (!id) return notFound();
        try {
          const provider = getProvider(id);
          if (!provider) return notFound("Provider not found");
          const body = await parseBody(req) as Record<string, unknown>;
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "api_key", "region", "access_key", "secret_key", "oauth_client_id", "oauth_client_secret", "oauth_refresh_token", "oauth_access_token", "oauth_token_expiry"]) {
            if (body[key] !== undefined) updates[key] = body[key];
          }
          const updated = updateProvider(id, updates as any);
          return json(sanitizeProvider(updated as unknown as Record<string, unknown>));
        } catch (e) { return internalError(e); }
      }

      // DELETE /api/providers/:id
      const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/);
      if (providerMatch && method === "DELETE") {
        const id = resolveId("providers", providerMatch[1]!);
        if (!id) return notFound();
        try {
          deleteProvider(id);
          return json({ ok: true });
        } catch (e) { return internalError(e); }
      }

      // POST /api/providers/:id/auth — Gmail OAuth re-authentication
      const providerAuthMatch = path.match(/^\/api\/providers\/([^/]+)\/auth$/);
      if (providerAuthMatch && method === "POST") {
        const id = resolveId("providers", providerAuthMatch[1]!);
        if (!id) return notFound();
        try {
          const provider = getProvider(id);
          if (!provider) return notFound("Provider not found");
          if (provider.type !== "gmail") return badRequest("Only Gmail providers support OAuth re-authentication");
          if (!provider.oauth_client_id || !provider.oauth_client_secret) {
            return badRequest("Provider is missing oauth_client_id or oauth_client_secret");
          }

          const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
          const tokens = await startGmailOAuthFlow(provider.oauth_client_id, provider.oauth_client_secret);

          const { updateProvider } = await import("../db/providers.js");
          const updated = updateProvider(id, {
            oauth_refresh_token: tokens.refresh_token,
            oauth_access_token: tokens.access_token,
            oauth_token_expiry: tokens.expiry,
          });

          return json({ ok: true, provider: updated });
        } catch (e) { return internalError(e); }
      }

      // GET /api/domains
      if (path === "/api/domains" && method === "GET") {
        try {
          const providerId = url.searchParams.get("provider_id") ?? undefined;
          const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
          return json(listDomains(resolvedId));
        } catch (e) { return internalError(e); }
      }

      // POST /api/domains
      if (path === "/api/domains" && method === "POST") {
        try {
          const body = await parseBody(req) as Record<string, unknown>;
          const providerId = resolveId("providers", String(body.provider_id ?? ""));
          if (!providerId) return notFound("Provider not found");

          const provider = getProvider(providerId);
          if (!provider) return notFound("Provider not found");

          const domainName = String(body.domain ?? "");
          if (!domainName) return badRequest("domain is required");

          const adapter = getAdapter(provider);
          await adapter.addDomain(domainName);

          const domain = createDomain(providerId, domainName);
          return json(domain, 201);
        } catch (e) { return internalError(e); }
      }

      // GET /api/domains/:id/dns
      const domainDnsMatch = path.match(/^\/api\/domains\/([^/]+)\/dns$/);
      if (domainDnsMatch && method === "GET") {
        const id = resolveId("domains", domainDnsMatch[1]!);
        if (!id) return notFound();
        try {
          const domain = getDomain(id);
          if (!domain) return notFound();

          const provider = getProvider(domain.provider_id);
          if (!provider) return notFound("Provider not found");

          const adapter = getAdapter(provider);
          const records = await adapter.getDnsRecords(domain.domain);
          return json(records);
        } catch (e) { return internalError(e); }
      }

      // POST /api/domains/:id/verify
      const domainVerifyMatch = path.match(/^\/api\/domains\/([^/]+)\/verify$/);
      if (domainVerifyMatch && method === "POST") {
        const id = resolveId("domains", domainVerifyMatch[1]!);
        if (!id) return notFound();
        try {
          const domain = getDomain(id);
          if (!domain) return notFound();

          const provider = getProvider(domain.provider_id);
          if (!provider) return notFound("Provider not found");

          const adapter = getAdapter(provider);
          const status = await adapter.verifyDomain(domain.domain);
          const updated = updateDnsStatus(id, status.dkim, status.spf, status.dmarc);
          return json(updated);
        } catch (e) { return internalError(e); }
      }

      // DELETE /api/domains/:id
      const domainMatch = path.match(/^\/api\/domains\/([^/]+)$/);
      if (domainMatch && method === "DELETE") {
        const id = resolveId("domains", domainMatch[1]!);
        if (!id) return notFound();
        try {
          deleteDomain(id);
          return json({ ok: true });
        } catch (e) { return internalError(e); }
      }

      // GET /api/addresses
      if (path === "/api/addresses" && method === "GET") {
        try {
          const providerId = url.searchParams.get("provider_id") ?? undefined;
          const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
          return json(listAddresses(resolvedId));
        } catch (e) { return internalError(e); }
      }

      // POST /api/addresses
      if (path === "/api/addresses" && method === "POST") {
        try {
          const body = await parseBody(req) as Record<string, unknown>;
          const providerId = resolveId("providers", String(body.provider_id ?? ""));
          if (!providerId) return notFound("Provider not found");

          const provider = getProvider(providerId);
          if (!provider) return notFound("Provider not found");

          const emailAddr = String(body.email ?? "");
          if (!emailAddr) return badRequest("email is required");

          const adapter = getAdapter(provider);
          await adapter.addAddress(emailAddr);

          const addr = createAddress({
            provider_id: providerId,
            email: emailAddr,
            display_name: body.display_name as string | undefined,
          });
          return json(addr, 201);
        } catch (e) { return internalError(e); }
      }

      // DELETE /api/addresses/:id
      const addressMatch = path.match(/^\/api\/addresses\/([^/]+)$/);
      if (addressMatch && method === "DELETE") {
        const id = resolveId("addresses", addressMatch[1]!);
        if (!id) return notFound();
        try {
          deleteAddress(id);
          return json({ ok: true });
        } catch (e) { return internalError(e); }
      }

      // GET /api/emails
      if (path === "/api/emails" && method === "GET") {
        try {
          const filter = {
            provider_id: url.searchParams.get("provider_id") ?? undefined,
            status: url.searchParams.get("status") as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined,
            since: url.searchParams.get("since") ?? undefined,
            limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50,
            offset: url.searchParams.has("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
          };
          return json(listEmails(filter));
        } catch (e) { return internalError(e); }
      }

      // GET /api/emails/search?q=...
      if (path === "/api/emails/search" && method === "GET") {
        try {
          const q = url.searchParams.get("q") ?? "";
          if (!q) return badRequest("q parameter is required");
          const since = url.searchParams.get("since") ?? undefined;
          const limit = url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
          return json(searchEmails(q, { since, limit }));
        } catch (e) { return internalError(e); }
      }

      // GET /api/emails/:id
      const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
      if (emailMatch && method === "GET") {
        const id = resolveId("emails", emailMatch[1]!);
        if (!id) return notFound();
        try {
          const email = getEmail(id);
          if (!email) return notFound();
          return json(email);
        } catch (e) { return internalError(e); }
      }

      // GET /api/events
      if (path === "/api/events" && method === "GET") {
        try {
          const filter = {
            email_id: url.searchParams.get("email_id") ?? undefined,
            provider_id: url.searchParams.get("provider_id") ?? undefined,
            type: url.searchParams.get("type") as "delivered" | "bounced" | "complained" | "opened" | "clicked" | "unsubscribed" | undefined,
            since: url.searchParams.get("since") ?? undefined,
            limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 100,
          };
          return json(listEvents(filter));
        } catch (e) { return internalError(e); }
      }

      // GET /api/stats
      if (path === "/api/stats" && method === "GET") {
        try {
          const providerId = url.searchParams.get("provider_id") ?? undefined;
          const period = url.searchParams.get("period") ?? "30d";
          const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
          const stats = getLocalStats(resolvedId, period);
          return json(stats);
        } catch (e) { return internalError(e); }
      }

      // POST /api/pull
      if (path === "/api/pull" && method === "POST") {
        try {
          const body = await parseBody(req) as Record<string, unknown>;
          let result: Record<string, number>;
          if (body.provider_id) {
            const id = resolveId("providers", String(body.provider_id)) ?? String(body.provider_id);
            const count = await syncProvider(id);
            result = { [id]: count };
          } else {
            result = await syncAll();
          }
          return json(result);
        } catch (e) { return internalError(e); }
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

        return notFound();
      }

      return notFound();
    },
  });

  console.log(`\nEmails dashboard running at http://localhost:${server.port}`);
  console.log(`API available at http://localhost:${server.port}/api`);
  console.log(`Press Ctrl+C to stop\n`);
}
