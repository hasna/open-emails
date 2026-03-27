/**
 * Gmail inbox sync via @hasna/connect-gmail SDK.
 *
 * Uses Gmail.createWithTokens() to authenticate with credentials stored in the
 * open-emails providers table, bypassing the connector's file-based auth entirely.
 *
 * Features:
 * - Full MIME fetch (text + HTML body) via messages.get(id, 'full')
 * - Attachment download (local or S3) via attachments.downloadAll()
 * - Auto token refresh with persistence back to providers table
 * - Pagination support via nextPageToken
 * - Dedup by (provider_id, message_id) — safe to re-run
 * - Per-message error isolation — one failure doesn't abort the whole run
 */

import { Gmail } from "@hasna/connect-gmail";
import type { GmailTokens } from "@hasna/connect-gmail";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { storeInboundEmail, updateAttachmentPaths, listInboundEmails } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";
import { getProvider, updateProvider } from "../db/providers.js";
import { getDatabase, getDataDir } from "../db/database.js";
import { getGmailSyncConfig } from "./config.js";
import type { Provider } from "../types/index.js";
import type { Database } from "bun:sqlite";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorSyncOptions {
  /** open-emails provider ID */
  providerId: string;
  /** Gmail label ID, e.g. "INBOX", "SENT". Default: "INBOX" */
  labelFilter?: string;
  /** Gmail search query, e.g. "is:unread from:someone@example.com" */
  query?: string;
  /** Max messages per batch fetch. Default: 50 */
  batchSize?: number;
  /** Total max messages to sync in this run */
  maxMessages?: number;
  /** Only fetch messages after this ISO date string */
  since?: string;
  /** Resume pagination from this page token */
  pageToken?: string;
  /** Download and store attachment files. Default: true */
  downloadAttachments?: boolean;
  db?: Database;
}

/** @deprecated Use ConnectorSyncOptions */
export type GmailSyncOptions = ConnectorSyncOptions;

export interface GmailSyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  nextPageToken?: string;
  done: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function buildQuery(opts: ConnectorSyncOptions): string | undefined {
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

function getAttachmentDir(emailId: string): string {
  const dir = join(getDataDir(), "attachments", emailId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a Gmail SDK instance from a provider record.
 * Tokens are refreshed automatically; new tokens are persisted back to the DB.
 */
function makeGmailClient(provider: Provider): Gmail {
  const tokens: GmailTokens = {
    accessToken: provider.oauth_access_token ?? "",
    refreshToken: provider.oauth_refresh_token ?? "",
    clientId: provider.oauth_client_id ?? "",
    clientSecret: provider.oauth_client_secret ?? "",
    expiresAt: provider.oauth_token_expiry
      ? new Date(provider.oauth_token_expiry).getTime()
      : undefined,
  };

  return Gmail.createWithTokens(tokens, (refreshed) => {
    // Persist refreshed tokens back to the providers table
    try {
      updateProvider(provider.id, {
        oauth_access_token: refreshed.accessToken,
        oauth_token_expiry: refreshed.expiresAt
          ? new Date(refreshed.expiresAt).toISOString()
          : undefined,
      });
    } catch {
      // Non-fatal — token still usable in-memory for this session
    }
  });
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Sync one page of Gmail messages into the inbound_emails table.
 * Fetches full MIME (text + HTML body) and downloads attachments.
 *
 * @example
 * let token: string | undefined;
 * do {
 *   const result = await syncGmailInbox({ providerId, pageToken: token });
 *   token = result.nextPageToken;
 * } while (!result.done);
 */
export async function syncGmailInbox(opts: ConnectorSyncOptions): Promise<GmailSyncResult> {
  const db = opts.db ?? getDatabase();
  const batchSize = opts.batchSize ?? 50;
  const downloadAttachments = opts.downloadAttachments ?? true;
  const syncConfig = getGmailSyncConfig();
  const result: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };

  // Resolve provider
  const provider = getProvider(opts.providerId, db);
  if (!provider || provider.type !== "gmail") {
    result.errors.push(`Provider not found or not a Gmail provider: ${opts.providerId}`);
    return result;
  }

  const gmail = makeGmailClient(provider);

  // List messages
  let listRes: Awaited<ReturnType<typeof gmail.messages.list>>;
  try {
    listRes = await gmail.messages.list({
      maxResults: batchSize,
      labelIds: opts.labelFilter ? [opts.labelFilter] : ["INBOX"],
      q: buildQuery(opts),
      pageToken: opts.pageToken,
    });
  } catch (e) {
    result.errors.push(`Failed to list messages: ${String(e)}`);
    return result;
  }

  const messages = listRes.messages ?? [];
  if (listRes.nextPageToken) {
    result.nextPageToken = listRes.nextPageToken;
    result.done = false;
  }

  const capped = opts.maxMessages != null ? messages.slice(0, opts.maxMessages) : messages;

  for (const msgRef of capped) {
    if (!msgRef.id) continue;

    try {
      // Dedup by (provider_id, message_id) — safe to re-run
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE provider_id = ? AND message_id = ? LIMIT 1")
        .get(opts.providerId, msgRef.id);
      if (existing) {
        result.skipped++;
        continue;
      }

      // Fetch full MIME message
      const msg = await gmail.messages.get(msgRef.id, "full");
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      const textBody = gmail.messages.extractBody(msg, false) || null;
      const htmlBody = gmail.messages.extractBody(msg, true) || null;
      const receivedAt = parseDate(getHeader("date") || (msg.internalDate
        ? new Date(parseInt(msg.internalDate, 10)).toISOString()
        : ""));

      // List attachments from MIME tree (metadata only at this point)
      const attachmentList = await gmail.attachments.list(msgRef.id);
      const attachmentMeta = attachmentList.map((a) => ({
        filename: a.filename,
        content_type: a.mimeType,
        size: a.size,
      }));

      // Store email
      const stored = storeInboundEmail(
        {
          provider_id: opts.providerId,
          message_id: msgRef.id,
          in_reply_to_email_id: null,
          from_address: getHeader("from"),
          to_addresses: parseAddresses(getHeader("to")),
          cc_addresses: parseAddresses(getHeader("cc")),
          subject: getHeader("subject") || "(no subject)",
          text_body: textBody,
          html_body: htmlBody,
          attachments: attachmentMeta,
          attachment_paths: [],
          headers: Object.fromEntries(headers.map((h) => [h.name ?? "", h.value ?? ""])),
          raw_size: msg.sizeEstimate ?? 0,
          received_at: receivedAt,
        },
        db,
      );

      result.synced++;

      // Download attachments if requested and there are any
      if (downloadAttachments && attachmentList.length > 0 && syncConfig.attachment_storage !== "none") {
        const paths: AttachmentPath[] = [];

        if (syncConfig.attachment_storage === "s3" && syncConfig.s3_bucket) {
          // Download locally first, then upload to S3
          const outputDir = getAttachmentDir(stored.id);
          const downloaded = await gmail.attachments.downloadAll(msgRef.id, outputDir);

          for (const d of downloaded) {
            try {
              const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
              const { readFileSync } = await import("node:fs");
              const client = new S3Client({ region: syncConfig.s3_region ?? "us-east-1" });
              const key = `${syncConfig.s3_prefix ?? "emails"}/${stored.id}/${d.filename}`;
              await client.send(new PutObjectCommand({
                Bucket: syncConfig.s3_bucket,
                Key: key,
                Body: readFileSync(d.path),
                ContentType: d.mimeType,
              }));
              paths.push({
                filename: d.filename,
                content_type: d.mimeType,
                size: d.size,
                s3_url: `s3://${syncConfig.s3_bucket}/${key}`,
                local_path: d.path,
              });
              result.attachments_saved++;
            } catch (e) {
              result.errors.push(`S3 upload ${d.filename}: ${String(e)}`);
              // Keep local path even if S3 fails
              paths.push({ filename: d.filename, content_type: d.mimeType, size: d.size, local_path: d.path });
              result.attachments_saved++;
            }
          }
        } else {
          // Local storage only
          const outputDir = getAttachmentDir(stored.id);
          const downloaded = await gmail.attachments.downloadAll(msgRef.id, outputDir);
          for (const d of downloaded) {
            paths.push({ filename: d.filename, content_type: d.mimeType, size: d.size, local_path: d.path });
            result.attachments_saved++;
          }
        }

        if (paths.length > 0) {
          updateAttachmentPaths(stored.id, paths, db);
        }
      }
    } catch (e) {
      result.errors.push(`Message ${msgRef.id}: ${String(e)}`);
    }
  }

  return result;
}

/**
 * Sync ALL pages until done. Convenience wrapper for full backfills.
 */
export async function syncGmailInboxAll(opts: Omit<ConnectorSyncOptions, "pageToken">): Promise<GmailSyncResult> {
  const aggregate: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };
  let pageToken: string | undefined;

  do {
    const page = await syncGmailInbox({ ...opts, pageToken });
    aggregate.synced += page.synced;
    aggregate.skipped += page.skipped;
    aggregate.attachments_saved += page.attachments_saved;
    aggregate.errors.push(...page.errors);
    pageToken = page.nextPageToken;
    aggregate.done = page.done;

    if (aggregate.errors.length >= 20) {
      aggregate.errors.push("Too many errors — aborting pagination");
      break;
    }
  } while (!aggregate.done);

  return aggregate;
}

/**
 * List available Gmail labels for a provider.
 */
export async function listGmailLabels(providerId: string): Promise<{ id: string; name: string }[]> {
  const provider = getProvider(providerId);
  if (!provider || provider.type !== "gmail") return [];
  const gmail = makeGmailClient(provider);
  try {
    const labels = await gmail.labels.list();
    return (labels.labels ?? []).map((l) => ({ id: l.id ?? "", name: l.name ?? "" }));
  } catch {
    return [];
  }
}

export { listInboundEmails };
