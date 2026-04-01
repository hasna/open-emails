import { getProvider } from "../db/providers.js";
import { getAdapter } from "../providers/index.js";
import { getFailoverProviderIds } from "./config.js";
import type { SendEmailOptions } from "../types/index.js";
import type { Database } from "../db/database.js";

export interface SendResult {
  messageId: string;
  providerId: string;
  usedFailover: boolean;
}

/**
 * Send an email with automatic failover.
 * If the primary provider fails and failover-providers is configured,
 * retries each failover provider in order.
 */
export async function sendWithFailover(
  primaryProviderId: string,
  opts: SendEmailOptions,
  db?: Database,
): Promise<SendResult> {
  const providerIds = [primaryProviderId, ...getFailoverProviderIds()];
  const errors: string[] = [];

  for (let i = 0; i < providerIds.length; i++) {
    const providerId = providerIds[i]!;
    const provider = getProvider(providerId, db);
    if (!provider) {
      errors.push(`Provider not found: ${providerId}`);
      continue;
    }

    try {
      const adapter = getAdapter(provider);
      const messageId = await adapter.sendEmail(opts);
      return { messageId, providerId, usedFailover: i > 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${provider.name}] ${msg}`);
      if (i < providerIds.length - 1) {
        process.stderr.write(`\n⚠ Send failed on ${provider.name}, trying failover...\n`);
      }
    }
  }

  throw new Error(`All providers failed:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`);
}
