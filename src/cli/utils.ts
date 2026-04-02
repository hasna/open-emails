import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { getDatabase, resolvePartialId } from "../db/database.js";

const ID_ERROR_SUGGESTION_LIMIT = 5;

export function handleError(e: unknown): never {
  console.error(chalk.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

export function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    const suggestions = getIdSuggestions(table, partialId);
    const suggestionText = suggestions.length > 0
      ? `\nSimilar IDs in ${table}: ${suggestions.join(", ")}`
      : "";
    console.error(chalk.red(`Could not resolve ID '${partialId}' in table '${table}'.${suggestionText}`));
    process.exit(1);
  }
  return id;
}

function getIdSuggestions(table: string, partialId: string): string[] {
  const db = getDatabase();
  try {
    const rows = db
      .query(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY created_at DESC LIMIT ?`)
      .all(`${partialId}%`, ID_ERROR_SUGGESTION_LIMIT) as Array<{ id?: string }>;
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export async function confirmDestructiveAction(message: string, yes?: boolean): Promise<void> {
  if (yes) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Destructive operation blocked in non-interactive mode. Re-run with --yes to confirm.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} Type 'yes' to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("Operation cancelled.");
    }
  } finally {
    rl.close();
  }
}

export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 300000;
  const val = parseInt(match[1]!);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60000;
    case "h": return val * 3600000;
    default: return 300000;
  }
}

export function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}
