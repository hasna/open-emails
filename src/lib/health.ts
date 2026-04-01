import chalk from "chalk";
import { listProviders } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listAddresses } from "../db/addresses.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "./stats.js";
import type { Database } from "../db/database.js";
import type { Provider } from "../types/index.js";

export interface ProviderHealth {
  provider: Provider;
  credentialsValid: boolean;
  credentialError?: string;
  domainCount: number;
  verifiedDomains: number;
  addressCount: number;
  verifiedAddresses: number;
  bounceRate: number;
  status: "healthy" | "warning" | "error";
}

export async function checkProviderHealth(provider: Provider, db?: Database): Promise<ProviderHealth> {
  const health: ProviderHealth = {
    provider,
    credentialsValid: false,
    domainCount: 0,
    verifiedDomains: 0,
    addressCount: 0,
    verifiedAddresses: 0,
    bounceRate: 0,
    status: "error",
  };

  // Test credentials
  try {
    const adapter = getAdapter(provider);
    await adapter.listDomains();
    health.credentialsValid = true;
  } catch (e) {
    health.credentialError = e instanceof Error ? e.message : String(e);
  }

  // Count local domains/addresses
  const domains = listDomains(provider.id, db);
  health.domainCount = domains.length;
  health.verifiedDomains = domains.filter(d => d.dkim_status === "verified").length;

  const addresses = listAddresses(provider.id, db);
  health.addressCount = addresses.length;
  health.verifiedAddresses = addresses.filter(a => a.verified).length;

  // Get bounce rate from local stats
  try {
    const stats = getLocalStats(provider.id, "30d", db);
    health.bounceRate = stats.bounce_rate;
  } catch {}

  // Determine overall status
  if (!health.credentialsValid) health.status = "error";
  else if (health.bounceRate > 5) health.status = "warning";
  else health.status = "healthy";

  return health;
}

export async function checkAllProviders(db?: Database): Promise<ProviderHealth[]> {
  const providers = listProviders(db).filter(p => p.active);
  const results: ProviderHealth[] = [];
  for (const p of providers) {
    results.push(await checkProviderHealth(p, db));
  }
  return results;
}

export function formatProviderHealth(h: ProviderHealth): string {
  const statusIcon = h.status === "healthy" ? chalk.green("●") : h.status === "warning" ? chalk.yellow("●") : chalk.red("●");
  const creds = h.credentialsValid ? chalk.green("valid") : chalk.red("invalid: " + (h.credentialError || "unknown"));
  const domains = `${h.verifiedDomains}/${h.domainCount} verified`;
  const addresses = `${h.verifiedAddresses}/${h.addressCount} verified`;
  const bounce = h.bounceRate > 5 ? chalk.red(`${h.bounceRate.toFixed(1)}%`) : chalk.green(`${h.bounceRate.toFixed(1)}%`);

  return [
    `${statusIcon} ${chalk.bold(h.provider.name)} (${h.provider.type})`,
    `  Credentials: ${creds}`,
    `  Domains: ${domains}`,
    `  Addresses: ${addresses}`,
    `  Bounce rate (30d): ${bounce}`,
  ].join("\n");
}
