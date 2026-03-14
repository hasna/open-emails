import chalk from "chalk";
import { getDatabase, resolvePartialId } from "../db/database.js";

export function handleError(e: unknown): never {
  console.error(chalk.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

export function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    console.error(chalk.red(`Could not resolve ID: ${partialId}`));
    process.exit(1);
  }
  return id;
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
