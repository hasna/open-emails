/**
 * Shared utilities for API route modules.
 */
import { getDatabase, resolvePartialId } from "../../db/database.js";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

export function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

export function internalError(e: unknown): Response {
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

export function resolveId(table: string, partialId: string): string | null {
  const db = getDatabase();
  return resolvePartialId(db, table, partialId);
}

export async function parseBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return {}; }
}

const CREDENTIAL_FIELDS = ["api_key", "secret_key", "access_key", "oauth_client_secret", "oauth_refresh_token", "oauth_access_token"] as const;

export function sanitizeProvider(provider: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...provider };
  for (const field of CREDENTIAL_FIELDS) {
    if (sanitized[field]) sanitized[field] = "***";
  }
  return sanitized;
}

const rateLimitWindows = new Map<string, number[]>();
export function checkRateLimit(ip: string, key: string, maxPerMinute: number): boolean {
  const mapKey = `${ip}:${key}`;
  const now = Date.now();
  const hits = (rateLimitWindows.get(mapKey) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= maxPerMinute) return false;
  hits.push(now);
  rateLimitWindows.set(mapKey, hits);
  return true;
}

export function tooManyRequests(): Response {
  return json({ error: "Too many requests. Please slow down." }, 429);
}
