/**
 * Shared utilities for MCP tool modules.
 */

import { getDatabase, resolvePartialId } from "../db/database.js";
import {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
} from "../types/index.js";

export function formatError(error: unknown): string {
  if (error instanceof ProviderNotFoundError) return `Provider not found: ${error.providerId}`;
  if (error instanceof DomainNotFoundError) return `Domain not found: ${error.domainId}`;
  if (error instanceof AddressNotFoundError) return `Address not found: ${error.addressId}`;
  if (error instanceof EmailNotFoundError) return `Email not found: ${error.emailId}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    const rows = db
      .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT 6`)
      .all(`${partialId}%`) as { id: string }[];

    if (rows.length === 0) {
      throw new Error(`Could not resolve ID '${partialId}' in table '${table}' (no matching rows).`);
    }

    const preview = rows.slice(0, 5).map((r) => r.id).join(", ");
    const extra = rows.length > 5 ? " (showing first 5)" : "";
    throw new Error(
      `Ambiguous ID '${partialId}' in table '${table}' (${rows.length} matches${extra}): ${preview}. Use a longer prefix or full ID.`,
    );
  }
  return id;
}

export { ProviderNotFoundError, DomainNotFoundError, AddressNotFoundError, EmailNotFoundError };
