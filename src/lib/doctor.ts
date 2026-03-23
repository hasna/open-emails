import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { listProviders } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listAddresses } from "../db/addresses.js";
import { listContacts } from "../db/contacts.js";
import { listTemplates } from "../db/templates.js";
import { checkAllProviders } from "./health.js";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDiagnostics(db?: Database): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. DB accessible
  try {
    const d = db || getDatabase();
    d.query("SELECT 1").get();
    checks.push({ name: "Database", status: "pass", message: "SQLite database accessible" });
  } catch (e) {
    checks.push({ name: "Database", status: "fail", message: `Database error: ${e}` });
  }

  // 2. Config file
  const { getDataDir } = await import("../db/database.js");
  const configPath = join(getDataDir(), "config.json");
  checks.push(
    existsSync(configPath)
      ? { name: "Config", status: "pass", message: "Config file exists" }
      : { name: "Config", status: "warn", message: "No config file (run 'emails config set' to create)" },
  );

  // 3. Providers
  const providers = listProviders(db);
  checks.push(
    providers.length > 0
      ? { name: "Providers", status: "pass", message: `${providers.length} provider(s) configured` }
      : { name: "Providers", status: "warn", message: "No providers configured" },
  );

  // 4. Provider health
  if (providers.length > 0) {
    const health = await checkAllProviders(db);
    for (const h of health) {
      checks.push({
        name: `Provider: ${h.provider.name}`,
        status: h.status === "healthy" ? "pass" : h.status === "warning" ? "warn" : "fail",
        message: h.credentialsValid ? "Credentials valid" : `Credentials invalid: ${h.credentialError}`,
      });
    }
  }

  // 5. Domains
  const domains = listDomains(undefined, db);
  const verifiedDomains = domains.filter((d) => d.dkim_status === "verified");
  checks.push({
    name: "Domains",
    status: verifiedDomains.length === domains.length && domains.length > 0 ? "pass" : "warn",
    message: `${verifiedDomains.length}/${domains.length} domains verified`,
  });

  // 6. Addresses
  const addresses = listAddresses(undefined, db);
  checks.push({ name: "Addresses", status: addresses.length > 0 ? "pass" : "warn", message: `${addresses.length} sender address(es)` });

  // 7. Contacts
  const contacts = listContacts(undefined, db);
  const suppressed = listContacts({ suppressed: true }, db);
  checks.push({
    name: "Contacts",
    status: suppressed.length > 0 ? "warn" : "pass",
    message: `${contacts.length} contacts (${suppressed.length} suppressed)`,
  });

  // 8. Templates
  const templates = listTemplates(db);
  checks.push({ name: "Templates", status: "pass", message: `${templates.length} template(s)` });

  return checks;
}

export function formatDiagnostics(checks: DoctorCheck[]): string {
  const icons = { pass: chalk.green("\u2713"), warn: chalk.yellow("\u26A0"), fail: chalk.red("\u2717") };
  let output = chalk.bold("\n  Email System Diagnostics\n\n");
  for (const check of checks) {
    output += `  ${icons[check.status]} ${check.name}: ${check.message}\n`;
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  output += `\n  ${chalk.bold("Summary:")} ${chalk.green(passed + " passed")}`;
  if (warned) output += ` ${chalk.yellow(warned + " warnings")}`;
  if (failed) output += ` ${chalk.red(failed + " failed")}`;
  output += "\n";
  return output;
}
