import type { Database } from "./database.js";
import type { AddressRow, CreateAddressInput, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function rowToAddress(row: AddressRow): EmailAddress {
  return {
    ...row,
    verified: !!row.verified,
  };
}

export function createAddress(input: CreateAddressInput, db?: Database): EmailAddress {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [id, input.provider_id, input.email, input.display_name || null, timestamp, timestamp],
  );

  return getAddress(id, d)!;
}

export function getAddress(id: string, db?: Database): EmailAddress | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE id = ?").get(id) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function getAddressByEmail(provider_id: string, email: string, db?: Database): EmailAddress | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE provider_id = ? AND email = ?").get(provider_id, email) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function listAddresses(provider_id?: string, db?: Database): EmailAddress[] {
  const d = db || getDatabase();
  if (provider_id) {
    const rows = d.query("SELECT * FROM addresses WHERE provider_id = ? ORDER BY created_at DESC").all(provider_id) as AddressRow[];
    return rows.map(rowToAddress);
  }
  const rows = d.query("SELECT * FROM addresses ORDER BY created_at DESC").all() as AddressRow[];
  return rows.map(rowToAddress);
}

export function updateAddress(
  id: string,
  input: Partial<Pick<EmailAddress, "display_name" | "verified">>,
  db?: Database,
): EmailAddress {
  const d = db || getDatabase();
  const address = getAddress(id, d);
  if (!address) throw new AddressNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];

  if (input.display_name !== undefined) { sets.push("display_name = ?"); params.push(input.display_name || null); }
  if (input.verified !== undefined) { sets.push("verified = ?"); params.push(input.verified ? 1 : 0); }

  params.push(id);
  d.run(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`, params);

  return getAddress(id, d)!;
}

export function deleteAddress(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM addresses WHERE id = ?", [id]);
  return result.changes > 0;
}

export function markVerified(id: string, db?: Database): EmailAddress {
  const d = db || getDatabase();
  const address = getAddress(id, d);
  if (!address) throw new AddressNotFoundError(id);

  d.run("UPDATE addresses SET verified = 1, updated_at = ? WHERE id = ?", [now(), id]);
  return getAddress(id, d)!;
}
