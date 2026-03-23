import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataDir } from "../db/database.js";

// Lazy getters so tests can override HOME via process.env before calling
function getConfigDir(): string { return getDataDir(); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }

interface EmailsConfig {
  default_provider?: string;
  [key: string]: unknown;
}

export function loadConfig(): EmailsConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveConfig(config: EmailsConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function getConfigValue(key: string): unknown {
  return loadConfig()[key];
}

export function setConfigValue(key: string, value: unknown): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

export function getDefaultProviderId(): string | undefined {
  return loadConfig().default_provider as string | undefined;
}

export function getFailoverProviderIds(): string[] {
  const val = loadConfig()["failover-providers"];
  if (!val) return [];
  return String(val).split(",").map(s => s.trim()).filter(Boolean);
}
