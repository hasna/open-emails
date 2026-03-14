import type { Database } from "bun:sqlite";
import { getDatabase, uuid, now } from "./database.js";

export interface InboundEmail {
  id: string;
  provider_id: string | null;
  message_id: string | null;
  in_reply_to_email_id: string | null;  // linked sent email if this is a reply
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  attachments: { filename: string; content_type: string; size: number }[];
  headers: Record<string, string>;
  raw_size: number;
  received_at: string;
  created_at: string;
}

interface InboundEmailRow {
  id: string;
  provider_id: string | null;
  message_id: string | null;
  in_reply_to_email_id?: string | null;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  attachments_json: string;
  headers_json: string;
  raw_size: number;
  received_at: string;
  created_at: string;
}

function rowToEmail(row: InboundEmailRow): InboundEmail {
  return {
    id: row.id,
    provider_id: row.provider_id,
    message_id: row.message_id,
    in_reply_to_email_id: row.in_reply_to_email_id ?? null,
    from_address: row.from_address,
    to_addresses: JSON.parse(row.to_addresses) as string[],
    cc_addresses: JSON.parse(row.cc_addresses) as string[],
    subject: row.subject,
    text_body: row.text_body,
    html_body: row.html_body,
    attachments: JSON.parse(row.attachments_json) as { filename: string; content_type: string; size: number }[],
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    raw_size: row.raw_size,
    received_at: row.received_at,
    created_at: row.created_at,
  };
}

function detectReplyToEmailId(headers: Record<string, string>, d: Database): string | null {
  // Check In-Reply-To and References headers for a known provider_message_id
  const candidates: string[] = [];
  const inReplyTo = headers["In-Reply-To"] || headers["in-reply-to"];
  const references = headers["References"] || headers["references"];
  if (inReplyTo) candidates.push(...inReplyTo.split(/\s+/).map(s => s.replace(/[<>]/g, "").trim()));
  if (references) candidates.push(...references.split(/\s+/).map(s => s.replace(/[<>]/g, "").trim()));

  for (const msgId of candidates) {
    if (!msgId) continue;
    const row = d.query("SELECT id FROM emails WHERE provider_message_id = ? LIMIT 1").get(msgId) as { id: string } | null;
    if (row) return row.id;
  }
  return null;
}

export function storeInboundEmail(
  input: Omit<InboundEmail, "id" | "created_at">,
  db?: Database,
): InboundEmail {
  const d = db || getDatabase();
  const id = uuid();

  // Auto-detect reply linkage from email headers
  const replyToEmailId = input.in_reply_to_email_id ?? detectReplyToEmailId(input.headers, d);

  d.run(
    `INSERT INTO inbound_emails
       (id, provider_id, message_id, in_reply_to_email_id, from_address, to_addresses, cc_addresses,
        subject, text_body, html_body, attachments_json, headers_json, raw_size, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider_id,
      input.message_id,
      replyToEmailId,
      input.from_address,
      JSON.stringify(input.to_addresses),
      JSON.stringify(input.cc_addresses),
      input.subject,
      input.text_body,
      input.html_body,
      JSON.stringify(input.attachments),
      JSON.stringify(input.headers),
      input.raw_size,
      input.received_at || now(),
    ],
  );

  const row = d.query("SELECT * FROM inbound_emails WHERE id = ?").get(id) as InboundEmailRow;
  return rowToEmail(row);
}

export function listReplies(emailId: string, db?: Database): InboundEmail[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM inbound_emails WHERE in_reply_to_email_id = ? ORDER BY received_at ASC")
    .all(emailId) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function getReplyCount(emailId: string, db?: Database): number {
  const d = db || getDatabase();
  const result = d.query("SELECT COUNT(*) as count FROM inbound_emails WHERE in_reply_to_email_id = ?").get(emailId) as { count: number } | null;
  return result?.count ?? 0;
}

export function getInboundEmail(id: string, db?: Database): InboundEmail | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM inbound_emails WHERE id = ?").get(id) as InboundEmailRow | null;
  if (!row) return null;
  return rowToEmail(row);
}

export function listInboundEmails(
  opts?: { provider_id?: string; since?: string; limit?: number },
  db?: Database,
): InboundEmail[] {
  const d = db || getDatabase();
  const limit = opts?.limit ?? 50;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = d
    .query(`SELECT * FROM inbound_emails ${where} ORDER BY received_at DESC LIMIT ?`)
    .all(...params) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function deleteInboundEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM inbound_emails WHERE id = ?", [id]);
  return result.changes > 0;
}

export function clearInboundEmails(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  let result: { changes: number };
  if (provider_id) {
    result = d.run("DELETE FROM inbound_emails WHERE provider_id = ?", [provider_id]);
  } else {
    result = d.run("DELETE FROM inbound_emails");
  }
  return result.changes;
}

export function getInboundCount(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  let row: { count: number } | null;
  if (provider_id) {
    row = d
      .query("SELECT COUNT(*) as count FROM inbound_emails WHERE provider_id = ?")
      .get(provider_id) as { count: number } | null;
  } else {
    row = d.query("SELECT COUNT(*) as count FROM inbound_emails").get() as { count: number } | null;
  }
  return row?.count ?? 0;
}
