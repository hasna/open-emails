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
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

export { ProviderNotFoundError, DomainNotFoundError, AddressNotFoundError, EmailNotFoundError };
