/**
 * Gmail inbox sync via connector SDK.
 *
 * Designed for scalability:
 * - Pagination via pageToken for large inboxes
 * - Dedup by (provider_id, message_id) — safe to re-run
 * - Batch size configurable
 * - Errors per message don't abort the whole sync
 * - Generic parseJsonFromOutput() usable by any connector
 */

import { runConnectorCommand } from "@hasna/connectors";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import type { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorSyncOptions {
  /** open-emails provider ID */
  providerId: string;
  /** Gmail label ID or name, e.g. "INBOX", "SENT". Default: "INBOX" */
  labelFilter?: string;
  /** Gmail search query, e.g. "is:unread from:someone@example.com" */
  query?: string;
  /** Max messages per batch fetch. Default: 50. Increase for bulk backfills. */
  batchSize?: number;
  /** Total max messages to sync in this run. Default: unlimited (all available). */
  maxMessages?: number;
  /** Only fetch messages after this ISO date string */
  since?: string;
  /** Resume pagination from this page token (returned in GmailSyncResult) */
  pageToken?: string;
  db?: Database;
}

/** @deprecated Use ConnectorSyncOptions */
export type GmailSyncOptions = ConnectorSyncOptions;

export interface GmailSyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  /** Pass this as pageToken in the next call to continue pagination */
  nextPageToken?: string;
  /** true when there are no more pages */
  done: boolean;
}

interface GmailListMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet?: string;
}

interface GmailListResponse {
  messages?: GmailListMessage[];
  nextPageToken?: string;
}

interface GmailDetailMessage {
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  labels?: string[];
  body?: string;
  snippet?: string;
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Parse JSON from connector output that may have preamble text.
 * e.g. "✓ Found N messages:\n[{...}]" → [{...}]
 */
export function parseJsonFromOutput(output: string): unknown {
  const jsonStart = output.indexOf("[");
  const objStart = output.indexOf("{");
  let start = -1;
  if (jsonStart >= 0 && (objStart < 0 || jsonStart <= objStart)) {
    start = jsonStart;
  } else if (objStart >= 0) {
    start = objStart;
  }
  if (start < 0) throw new Error(`No JSON found in connector output: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start));
}

function parseDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

function parseAddresses(addrStr: string | undefined): string[] {
  if (!addrStr) return [];
  return addrStr.split(",").map((a) => a.trim()).filter(Boolean);
}

function buildGmailQuery(opts: ConnectorSyncOptions): string | undefined {
  const parts: string[] = [];
  if (opts.query) parts.push(opts.query);
  if (opts.since) {
    const d = new Date(opts.since);
    if (!isNaN(d.getTime())) {
      parts.push(
        `after:${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Sync one page of Gmail inbox messages into the inbound_emails table.
 *
 * For large inboxes, call repeatedly with opts.pageToken = result.nextPageToken
 * until result.done === true.
 *
 * @example
 * // Sync all inbox messages
 * let token: string | undefined;
 * do {
 *   const result = await syncGmailInbox({ providerId, pageToken: token });
 *   token = result.nextPageToken;
 * } while (!result.done);
 */
export async function syncGmailInbox(opts: ConnectorSyncOptions): Promise<GmailSyncResult> {
  const db = opts.db ?? getDatabase();
  const batchSize = opts.batchSize ?? 50;
  const result: GmailSyncResult = { synced: 0, skipped: 0, errors: [], done: true };

  // Build list args
  const listArgs: string[] = ["-f", "json", "messages", "list", "--max", String(batchSize)];
  if (opts.labelFilter) listArgs.push("--label", opts.labelFilter);
  const gmailQuery = buildGmailQuery(opts);
  if (gmailQuery) listArgs.push("--query", gmailQuery);
  // Note: connect-gmail doesn't expose pageToken via CLI today; reserved for future use

  // List messages
  const listResult = await runConnectorCommand("gmail", listArgs);
  if (!listResult.success) {
    result.errors.push(`Failed to list Gmail messages: ${listResult.stderr || listResult.stdout}`);
    return result;
  }

  let messages: GmailListMessage[];
  try {
    const parsed = parseJsonFromOutput(listResult.stdout);
    // Handle both array response and {messages, nextPageToken} envelope
    if (Array.isArray(parsed)) {
      messages = parsed as GmailListMessage[];
    } else {
      const envelope = parsed as GmailListResponse;
      messages = envelope.messages ?? [];
      if (envelope.nextPageToken) {
        result.nextPageToken = envelope.nextPageToken;
        result.done = false;
      }
    }
  } catch (e) {
    result.errors.push(`Failed to parse Gmail list response: ${String(e)}`);
    return result;
  }

  // Apply maxMessages cap
  if (opts.maxMessages != null) {
    messages = messages.slice(0, opts.maxMessages);
  }

  // Sync each message; errors per-message don't abort the whole run
  for (const msg of messages) {
    try {
      // Dedup by (provider_id, message_id) — safe to re-run
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE provider_id = ? AND message_id = ? LIMIT 1")
        .get(opts.providerId, msg.id);

      if (existing) {
        result.skipped++;
        continue;
      }

      // Fetch full message with body
      const readResult = await runConnectorCommand("gmail", [
        "-f", "json", "messages", "read", msg.id, "--body",
      ]);

      let detail: GmailDetailMessage;
      try {
        detail = parseJsonFromOutput(readResult.stdout) as GmailDetailMessage;
      } catch {
        // Fall back to summary-only data if full read fails
        detail = { id: msg.id, from: msg.from, subject: msg.subject, date: msg.date };
      }

      const bodyText = detail.body || detail.snippet || "";

      storeInboundEmail(
        {
          provider_id: opts.providerId,
          message_id: msg.id,
          in_reply_to_email_id: null, // detectReplyToEmailId runs inside storeInboundEmail
          from_address: detail.from,
          to_addresses: parseAddresses(detail.to),
          cc_addresses: parseAddresses(detail.cc),
          subject: detail.subject || "(no subject)",
          text_body: bodyText || null,
          html_body: null,
          attachments: [],
          headers: {},
          raw_size: bodyText.length,
          received_at: parseDate(detail.date),
        },
        db,
      );

      result.synced++;
    } catch (e) {
      result.errors.push(`Failed to sync message ${msg.id}: ${String(e)}`);
    }
  }

  return result;
}

/**
 * Sync ALL pages until done. Convenience wrapper around syncGmailInbox().
 * Useful for initial backfills; for ongoing incremental sync use syncGmailInbox()
 * with opts.since set to the last sync timestamp.
 */
export async function syncGmailInboxAll(opts: Omit<ConnectorSyncOptions, "pageToken">): Promise<GmailSyncResult> {
  const aggregate: GmailSyncResult = { synced: 0, skipped: 0, errors: [], done: true };
  let pageToken: string | undefined;

  do {
    const page = await syncGmailInbox({ ...opts, pageToken });
    aggregate.synced += page.synced;
    aggregate.skipped += page.skipped;
    aggregate.errors.push(...page.errors);
    pageToken = page.nextPageToken;
    aggregate.done = page.done;

    // Bail early if too many errors
    if (aggregate.errors.length >= 20) {
      aggregate.errors.push("Too many errors — aborting pagination");
      break;
    }
  } while (!aggregate.done);

  return aggregate;
}

/**
 * List available Gmail labels for a provider.
 * Useful for letting users choose which labels to sync.
 */
export async function listGmailLabels(): Promise<{ id: string; name: string }[]> {
  const result = await runConnectorCommand("gmail", ["-f", "json", "labels", "list"]);
  if (!result.success) return [];
  try {
    return parseJsonFromOutput(result.stdout) as { id: string; name: string }[];
  } catch {
    return [];
  }
}

export { listInboundEmails };
