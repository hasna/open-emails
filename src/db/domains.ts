import type { Database } from "./database.js";
import type { Domain, DnsStatus } from "../types/index.js";
import { DomainNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

interface DomainRow {
  id: string;
  provider_id: string;
  domain: string;
  dkim_status: string;
  spf_status: string;
  dmarc_status: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDomain(row: DomainRow): Domain {
  return {
    ...row,
    dkim_status: row.dkim_status as DnsStatus,
    spf_status: row.spf_status as DnsStatus,
    dmarc_status: row.dmarc_status as DnsStatus,
  };
}

export function createDomain(
  provider_id: string,
  domain: string,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO domains (id, provider_id, domain, dkim_status, spf_status, dmarc_status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'pending', 'pending', ?, ?)`,
    [id, provider_id, domain, timestamp, timestamp],
  );

  return getDomain(id, d)!;
}

export function getDomain(id: string, db?: Database): Domain | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function getDomainByName(provider_id: string, domain: string, db?: Database): Domain | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM domains WHERE provider_id = ? AND domain = ?").get(provider_id, domain) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function listDomains(provider_id?: string, db?: Database): Domain[] {
  const d = db || getDatabase();
  if (provider_id) {
    const rows = d.query("SELECT * FROM domains WHERE provider_id = ? ORDER BY created_at DESC").all(provider_id) as DomainRow[];
    return rows.map(rowToDomain);
  }
  const rows = d.query("SELECT * FROM domains ORDER BY created_at DESC").all() as DomainRow[];
  return rows.map(rowToDomain);
}

export function updateDomain(
  id: string,
  input: Partial<Pick<Domain, "dkim_status" | "spf_status" | "dmarc_status" | "verified_at">>,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [now()];

  if (input.dkim_status !== undefined) { sets.push("dkim_status = ?"); params.push(input.dkim_status); }
  if (input.spf_status !== undefined) { sets.push("spf_status = ?"); params.push(input.spf_status); }
  if (input.dmarc_status !== undefined) { sets.push("dmarc_status = ?"); params.push(input.dmarc_status); }
  if (input.verified_at !== undefined) { sets.push("verified_at = ?"); params.push(input.verified_at); }

  params.push(id);
  d.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, params);

  return getDomain(id, d)!;
}

export function deleteDomain(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM domains WHERE id = ?", [id]);
  return result.changes > 0;
}

export function updateDnsStatus(
  id: string,
  dkim: DnsStatus,
  spf: DnsStatus,
  dmarc: DnsStatus,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  const allVerified = dkim === "verified" && spf === "verified" && dmarc === "verified";
  const timestamp = now();

  d.run(
    `UPDATE domains SET dkim_status = ?, spf_status = ?, dmarc_status = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
    [dkim, spf, dmarc, allVerified ? timestamp : domain.verified_at, timestamp, id],
  );

  return getDomain(id, d)!;
}
