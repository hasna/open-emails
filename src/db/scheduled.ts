import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

export type ScheduledStatus = "pending" | "sent" | "cancelled" | "failed";

export interface ScheduledEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: unknown[];
  template_name: string | null;
  template_vars: Record<string, string> | null;
  scheduled_at: string;
  status: ScheduledStatus;
  error: string | null;
  created_at: string;
}

interface ScheduledEmailRow {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: string;
  template_name: string | null;
  template_vars: string | null;
  scheduled_at: string;
  status: string;
  error: string | null;
  created_at: string;
}

function rowToScheduledEmail(row: ScheduledEmailRow): ScheduledEmail {
  return {
    ...row,
    to_addresses: JSON.parse(row.to_addresses || "[]") as string[],
    cc_addresses: JSON.parse(row.cc_addresses || "[]") as string[],
    bcc_addresses: JSON.parse(row.bcc_addresses || "[]") as string[],
    attachments_json: JSON.parse(row.attachments_json || "[]") as unknown[],
    template_vars: row.template_vars ? (JSON.parse(row.template_vars) as Record<string, string>) : null,
    status: row.status as ScheduledStatus,
  };
}

export function createScheduledEmail(
  input: {
    provider_id: string;
    from_address: string;
    to_addresses: string[];
    cc_addresses?: string[];
    bcc_addresses?: string[];
    reply_to?: string;
    subject: string;
    html?: string;
    text_body?: string;
    attachments_json?: unknown[];
    template_name?: string;
    template_vars?: Record<string, string>;
    scheduled_at: string;
  },
  db?: Database,
): ScheduledEmail {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO scheduled_emails (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, html, text_body, attachments_json, template_name, template_vars, scheduled_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      input.provider_id,
      input.from_address,
      JSON.stringify(input.to_addresses),
      JSON.stringify(input.cc_addresses || []),
      JSON.stringify(input.bcc_addresses || []),
      input.reply_to || null,
      input.subject,
      input.html || null,
      input.text_body || null,
      JSON.stringify(input.attachments_json || []),
      input.template_name || null,
      input.template_vars ? JSON.stringify(input.template_vars) : null,
      input.scheduled_at,
      timestamp,
    ],
  );

  return getScheduledEmail(id, d)!;
}

export function getScheduledEmail(id: string, db?: Database): ScheduledEmail | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM scheduled_emails WHERE id = ?").get(id) as ScheduledEmailRow | null;
  if (!row) return null;
  return rowToScheduledEmail(row);
}

export function listScheduledEmails(opts?: { status?: ScheduledStatus }, db?: Database): ScheduledEmail[] {
  const d = db || getDatabase();
  if (opts?.status) {
    const rows = d
      .query("SELECT * FROM scheduled_emails WHERE status = ? ORDER BY scheduled_at ASC")
      .all(opts.status) as ScheduledEmailRow[];
    return rows.map(rowToScheduledEmail);
  }
  const rows = d.query("SELECT * FROM scheduled_emails ORDER BY scheduled_at ASC").all() as ScheduledEmailRow[];
  return rows.map(rowToScheduledEmail);
}

export function cancelScheduledEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run(
    "UPDATE scheduled_emails SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    [id],
  );
  return result.changes > 0;
}

export function getDueEmails(db?: Database): ScheduledEmail[] {
  const d = db || getDatabase();
  const currentTime = now();
  const rows = d
    .query("SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC")
    .all(currentTime) as ScheduledEmailRow[];
  return rows.map(rowToScheduledEmail);
}

export function markSent(id: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE scheduled_emails SET status = 'sent' WHERE id = ?", [id]);
}

export function markFailed(id: string, error: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE scheduled_emails SET status = 'failed', error = ? WHERE id = ?", [error, id]);
}
