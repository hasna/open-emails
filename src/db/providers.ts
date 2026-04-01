import type { Database } from "./database.js";
import type { CreateProviderInput, Provider, ProviderRow } from "../types/index.js";
import { ProviderNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function rowToProvider(row: ProviderRow): Provider {
  return {
    ...row,
    active: !!row.active,
    type: row.type as Provider["type"],
  };
}

export function createProvider(input: CreateProviderInput, db?: Database): Provider {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO providers (id, name, type, api_key, region, access_key, secret_key,
       oauth_client_id, oauth_client_secret, oauth_refresh_token, oauth_access_token, oauth_token_expiry,
       active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.name,
      input.type,
      input.api_key || null,
      input.region || null,
      input.access_key || null,
      input.secret_key || null,
      input.oauth_client_id || null,
      input.oauth_client_secret || null,
      input.oauth_refresh_token || null,
      input.oauth_access_token || null,
      input.oauth_token_expiry || null,
      timestamp,
      timestamp,
    ],
  );

  return getProvider(id, d)!;
}

export function getProvider(id: string, db?: Database): Provider | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | null;
  if (!row) return null;
  return rowToProvider(row);
}

export function listProviders(db?: Database): Provider[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM providers ORDER BY created_at DESC").all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function updateProvider(
  id: string,
  input: Partial<CreateProviderInput> & { active?: boolean },
  db?: Database,
): Provider {
  const d = db || getDatabase();
  const provider = getProvider(id, d);
  if (!provider) throw new ProviderNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];

  if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
  if (input.type !== undefined) { sets.push("type = ?"); params.push(input.type); }
  if (input.api_key !== undefined) { sets.push("api_key = ?"); params.push(input.api_key || null); }
  if (input.region !== undefined) { sets.push("region = ?"); params.push(input.region || null); }
  if (input.access_key !== undefined) { sets.push("access_key = ?"); params.push(input.access_key || null); }
  if (input.secret_key !== undefined) { sets.push("secret_key = ?"); params.push(input.secret_key || null); }
  if (input.oauth_client_id !== undefined) { sets.push("oauth_client_id = ?"); params.push(input.oauth_client_id || null); }
  if (input.oauth_client_secret !== undefined) { sets.push("oauth_client_secret = ?"); params.push(input.oauth_client_secret || null); }
  if (input.oauth_refresh_token !== undefined) { sets.push("oauth_refresh_token = ?"); params.push(input.oauth_refresh_token || null); }
  if (input.oauth_access_token !== undefined) { sets.push("oauth_access_token = ?"); params.push(input.oauth_access_token || null); }
  if (input.oauth_token_expiry !== undefined) { sets.push("oauth_token_expiry = ?"); params.push(input.oauth_token_expiry || null); }
  if (input.active !== undefined) { sets.push("active = ?"); params.push(input.active ? 1 : 0); }

  params.push(id);
  d.run(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`, params);

  return getProvider(id, d)!;
}

export function deleteProvider(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM providers WHERE id = ?", [id]);
  return result.changes > 0;
}

export function getActiveProvider(db?: Database): Provider {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM providers WHERE active = 1 ORDER BY created_at LIMIT 1").get() as ProviderRow | null;
  if (!row) throw new ProviderNotFoundError("(no active provider)");
  return rowToProvider(row);
}
