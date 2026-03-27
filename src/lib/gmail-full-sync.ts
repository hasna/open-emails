/**
 * Gmail full sync — fetches complete MIME messages including HTML body and attachments.
 *
 * Uses the Gmail API directly (googleapis) with format=full to get the complete
 * MIME tree. Attachment content is downloaded and stored locally or in S3.
 *
 * Unlike gmail-sync.ts (which uses the connector for basic text bodies),
 * this module uses oauth credentials from the provider record to call the
 * Gmail API directly.
 */

import { google } from "googleapis";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, getDataDir } from "../db/database.js";
import { storeInboundEmail, updateAttachmentPaths } from "../db/inbound.js";
import type { AttachmentMeta, AttachmentPath } from "../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";
import { getGmailSyncConfig } from "./config.js";
import type { Provider } from "../types/index.js";
import type { Database } from "bun:sqlite";
import type { gmail_v1 } from "googleapis";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FullSyncOptions {
  provider: Provider;
  labelFilter?: string;
  query?: string;
  batchSize?: number;
  maxMessages?: number;
  since?: string;
  /** If true, also download and store attachment files */
  downloadAttachments?: boolean;
  db?: Database;
}

export interface FullSyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  done: boolean;
  nextPageToken?: string;
}

interface ParsedMessage {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  text_body: string | null;
  html_body: string | null;
  attachments: (AttachmentMeta & { attachment_id?: string; data?: string })[];
  headers: Record<string, string>;
  raw_size: number;
}

// ─── OAuth client factory ─────────────────────────────────────────────────────

function makeGmailClient(provider: Provider) {
  const oauth2 = new google.auth.OAuth2(
    provider.oauth_client_id!,
    provider.oauth_client_secret!,
  );
  oauth2.setCredentials({
    refresh_token: provider.oauth_refresh_token!,
    access_token: provider.oauth_access_token ?? undefined,
    expiry_date: provider.oauth_token_expiry
      ? new Date(provider.oauth_token_expiry).getTime()
      : undefined,
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}

// ─── MIME parsing ─────────────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function decodeBase64UrlBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walkParts(
  part: gmail_v1.Schema$MessagePart,
  result: { text?: string; html?: string; attachments: (AttachmentMeta & { attachment_id?: string; data?: string })[] },
): void {
  const mimeType = part.mimeType ?? "";
  const body = part.body;

  if (mimeType === "text/plain" && body?.data && !result.text) {
    result.text = decodeBase64Url(body.data);
  } else if (mimeType === "text/html" && body?.data && !result.html) {
    result.html = decodeBase64Url(body.data);
  } else if (mimeType.startsWith("multipart/")) {
    for (const sub of part.parts ?? []) {
      walkParts(sub, result);
    }
  } else if (
    mimeType !== "text/plain" &&
    mimeType !== "text/html" &&
    (part.filename || body?.attachmentId)
  ) {
    // This is an attachment
    const filename = part.filename || `attachment_${result.attachments.length + 1}`;
    const size = body?.size ?? 0;
    const attachment_id = body?.attachmentId;
    const inlineData = body?.data;

    result.attachments.push({
      filename,
      content_type: mimeType || "application/octet-stream",
      size,
      attachment_id,
      data: inlineData, // small attachments may be inline
    });
  }
}

function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? [];

  const parsed: ParsedMessage = {
    subject: getHeader(headers, "subject") || "(no subject)",
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to").split(",").map((s) => s.trim()).filter(Boolean),
    cc: getHeader(headers, "cc").split(",").map((s) => s.trim()).filter(Boolean),
    date: getHeader(headers, "date"),
    text_body: null,
    html_body: null,
    attachments: [],
    headers: Object.fromEntries(headers.map((h) => [h.name ?? "", h.value ?? ""])),
    raw_size: msg.sizeEstimate ?? 0,
  };

  const partsResult: { text?: string; html?: string; attachments: (AttachmentMeta & { attachment_id?: string; data?: string })[] } = {
    attachments: [],
  };

  // Single-part message
  if (!payload.parts && payload.body?.data) {
    if (payload.mimeType === "text/html") {
      partsResult.html = decodeBase64Url(payload.body.data);
    } else {
      partsResult.text = decodeBase64Url(payload.body.data);
    }
  } else {
    walkParts(payload as gmail_v1.Schema$MessagePart, partsResult);
  }

  parsed.text_body = partsResult.text ?? null;
  parsed.html_body = partsResult.html ?? null;
  parsed.attachments = partsResult.attachments;

  return parsed;
}

function parseDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

// ─── Attachment storage ───────────────────────────────────────────────────────

function getAttachmentDir(emailId: string): string {
  const dir = join(getDataDir(), "attachments", emailId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveAttachmentLocal(
  emailId: string,
  filename: string,
  data: Buffer,
): Promise<string> {
  const dir = getAttachmentDir(emailId);
  // Sanitize filename
  const safe = filename.replace(/[/\\?%*:|"<>]/g, "_");
  const path = join(dir, safe);
  writeFileSync(path, data);
  return path;
}

async function saveAttachmentS3(
  emailId: string,
  filename: string,
  data: Buffer,
  contentType: string,
  config: ReturnType<typeof getGmailSyncConfig>,
): Promise<string> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: config.s3_region ?? "us-east-1" });
  const key = `${config.s3_prefix ?? "emails"}/${emailId}/${filename.replace(/[/\\?%*:|"<>]/g, "_")}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3_bucket!,
      Key: key,
      Body: data,
      ContentType: contentType,
    }),
  );
  return `s3://${config.s3_bucket}/${key}`;
}

// ─── Core full sync ───────────────────────────────────────────────────────────

/**
 * Sync one page of Gmail messages with full MIME (HTML + attachments).
 */
export async function syncGmailFull(opts: FullSyncOptions): Promise<FullSyncResult> {
  const db = opts.db ?? getDatabase();
  const gmail = makeGmailClient(opts.provider);
  const syncConfig = getGmailSyncConfig();
  const batchSize = opts.batchSize ?? 50;
  const downloadAttachments = opts.downloadAttachments ?? true;
  const result: FullSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };

  // Build query
  const queryParts: string[] = [];
  if (opts.query) queryParts.push(opts.query);
  if (opts.since) {
    const d = new Date(opts.since);
    if (!isNaN(d.getTime())) {
      queryParts.push(
        `after:${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
      );
    }
  }

  // List messages
  let listRes: Awaited<ReturnType<typeof gmail.users.messages.list>>;
  try {
    listRes = await gmail.users.messages.list({
      userId: "me",
      labelIds: opts.labelFilter ? [opts.labelFilter] : ["INBOX"],
      q: queryParts.length > 0 ? queryParts.join(" ") : undefined,
      maxResults: batchSize,
    });
  } catch (e) {
    result.errors.push(`Failed to list messages: ${String(e)}`);
    return result;
  }

  const messages = listRes.data.messages ?? [];
  if (listRes.data.nextPageToken) {
    result.nextPageToken = listRes.data.nextPageToken;
    result.done = false;
  }

  const capped = opts.maxMessages != null ? messages.slice(0, opts.maxMessages) : messages;

  for (const msgRef of capped) {
    if (!msgRef.id) continue;

    try {
      // Dedup
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE provider_id = ? AND message_id = ? LIMIT 1")
        .get(opts.provider.id, msgRef.id);
      if (existing) {
        result.skipped++;
        continue;
      }

      // Fetch full message
      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: msgRef.id,
        format: "full",
      });

      const parsed = parseMessage(msgRes.data);
      const receivedAt = parsed.date ? parseDate(parsed.date) : new Date().toISOString();

      // Store email (without attachment files yet)
      const stored = storeInboundEmail(
        {
          provider_id: opts.provider.id,
          message_id: msgRef.id,
          in_reply_to_email_id: null,
          from_address: parsed.from,
          to_addresses: parsed.to,
          cc_addresses: parsed.cc,
          subject: parsed.subject,
          text_body: parsed.text_body,
          html_body: parsed.html_body,
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename,
            content_type: a.content_type,
            size: a.size,
          })),
          attachment_paths: [],
          headers: parsed.headers,
          raw_size: parsed.raw_size,
          received_at: receivedAt,
        },
        db,
      );

      result.synced++;

      // Download and store attachments
      if (downloadAttachments && parsed.attachments.length > 0 && syncConfig.attachment_storage !== "none") {
        const paths: AttachmentPath[] = [];

        for (const att of parsed.attachments) {
          try {
            let data: Buffer;

            if (att.data) {
              // Inline attachment data
              data = decodeBase64UrlBuffer(att.data);
            } else if (att.attachment_id) {
              // Fetch from Gmail
              const attRes = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: msgRef.id,
                id: att.attachment_id,
              });
              if (!attRes.data.data) continue;
              data = decodeBase64UrlBuffer(attRes.data.data);
            } else {
              continue;
            }

            const pathEntry: AttachmentPath = {
              filename: att.filename,
              content_type: att.content_type,
              size: data.length,
            };

            if (syncConfig.attachment_storage === "s3" && syncConfig.s3_bucket) {
              pathEntry.s3_url = await saveAttachmentS3(stored.id, att.filename, data, att.content_type, syncConfig);
            } else {
              pathEntry.local_path = await saveAttachmentLocal(stored.id, att.filename, data);
            }

            paths.push(pathEntry);
            result.attachments_saved++;
          } catch (e) {
            result.errors.push(`Attachment ${att.filename} for ${msgRef.id}: ${String(e)}`);
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
 * Sync all pages until done (full backfill).
 */
export async function syncGmailFullAll(opts: Omit<FullSyncOptions, "pageToken">): Promise<FullSyncResult> {
  const aggregate: FullSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };

  let done = false;
  let nextPageToken: string | undefined;

  while (!done) {
    const page = await syncGmailFull({ ...opts });
    aggregate.synced += page.synced;
    aggregate.skipped += page.skipped;
    aggregate.attachments_saved += page.attachments_saved;
    aggregate.errors.push(...page.errors);
    nextPageToken = page.nextPageToken;
    done = page.done;

    if (aggregate.errors.length >= 20) {
      aggregate.errors.push("Too many errors — aborting");
      break;
    }
  }

  aggregate.done = done;
  aggregate.nextPageToken = nextPageToken;
  return aggregate;
}
