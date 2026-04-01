import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: number;
  created_at: string;
  updated_at: string;
}

function rowToContact(row: ContactRow): Contact {
  return {
    ...row,
    suppressed: !!row.suppressed,
  };
}

export function upsertContact(email: string, db?: Database): Contact {
  const d = db || getDatabase();
  const existing = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (existing) return rowToContact(existing);

  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 0, 0, NULL, 0, ?, ?)`,
    [id, email, timestamp, timestamp],
  );

  return getContact(email, d)!;
}

export function getContact(email: string, db?: Database): Contact | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (!row) return null;
  return rowToContact(row);
}

export function listContacts(opts?: { suppressed?: boolean }, db?: Database): Contact[] {
  const d = db || getDatabase();
  if (opts?.suppressed !== undefined) {
    const rows = d
      .query("SELECT * FROM contacts WHERE suppressed = ? ORDER BY updated_at DESC")
      .all(opts.suppressed ? 1 : 0) as ContactRow[];
    return rows.map(rowToContact);
  }
  const rows = d.query("SELECT * FROM contacts ORDER BY updated_at DESC").all() as ContactRow[];
  return rows.map(rowToContact);
}

export function suppressContact(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 1, updated_at = ? WHERE email = ?", [now(), email]);
}

export function unsuppressContact(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 0, updated_at = ? WHERE email = ?", [now(), email]);
}

export function incrementSendCount(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run(
    "UPDATE contacts SET send_count = send_count + 1, last_sent_at = ?, updated_at = ? WHERE email = ?",
    [now(), now(), email],
  );
}

export function incrementBounceCount(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run(
    "UPDATE contacts SET bounce_count = bounce_count + 1, updated_at = ? WHERE email = ?",
    [now(), email],
  );
  // Auto-suppress on 3+ bounces
  const contact = getContact(email, d);
  if (contact && contact.bounce_count >= 3) {
    d.run("UPDATE contacts SET suppressed = 1, updated_at = ? WHERE email = ?", [now(), email]);
  }
}

export function incrementComplaintCount(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run(
    "UPDATE contacts SET complaint_count = complaint_count + 1, updated_at = ? WHERE email = ?",
    [now(), email],
  );
}

export function isContactSuppressed(email: string, db?: Database): boolean {
  const d = db || getDatabase();
  const row = d.query("SELECT suppressed FROM contacts WHERE email = ?").get(email) as { suppressed: number } | null;
  return row?.suppressed === 1;
}
