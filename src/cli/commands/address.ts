import type { Command } from "commander";
import chalk from "chalk";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../../db/addresses.js";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { colorDnsStatus } from "../../lib/format.js";
import { handleError, resolveId } from "../utils.js";

export function registerAddressCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const addressCmd = program.command("address").description("Manage sender email addresses");

  addressCmd
    .command("add <email>")
    .description("Add a sender address")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--name <displayName>", "Display name")
    .action(async (email: string, opts: { provider: string; name?: string }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        const adapter = getAdapter(provider!);
        await adapter.addAddress(email);

        const addr = createAddress({ provider_id: providerId, email, display_name: opts.name });
        console.log(chalk.green(`✓ Address added: ${email} (${addr.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("list")
    .description("List sender addresses")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const addresses = listAddresses(providerId);
        if (addresses.length === 0) {
          output([], chalk.dim("No addresses configured."));
          return;
        }
        const lines: string[] = [chalk.bold("\nAddresses:")];
        for (const a of addresses) {
          const verified = a.verified ? colorDnsStatus("verified") : colorDnsStatus("pending");
          const name = a.display_name ? ` (${a.display_name})` : "";
          lines.push(`  ${chalk.cyan(a.id.slice(0, 8))}  ${a.email}${name}  [${verified}]`);
        }
        lines.push("");
        output(addresses, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("verify <email>")
    .description("Check verification status of an address")
    .option("--provider <id>", "Provider ID")
    .action(async (email: string, opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const addresses = listAddresses(providerId);
        const found = addresses.find((a) => a.email === email);
        if (!found) handleError(new Error(`Address not found: ${email}`));

        const provider = getProvider(found!.provider_id);
        if (!provider) handleError(new Error("Provider not found"));

        const adapter = getAdapter(provider!);
        const isVerified = await adapter.verifyAddress(email);

        if (isVerified) {
          const db = getDatabase();
          db.run("UPDATE addresses SET verified = 1, updated_at = datetime('now') WHERE id = ?", [found!.id]);
          console.log(chalk.green(`✓ ${email} is verified`));
        } else {
          console.log(chalk.yellow(`⚠ ${email} is not yet verified`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("remove <id>")
    .description("Remove a sender address")
    .action((id: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        const addr = getAddress(resolvedId);
        if (!addr) handleError(new Error(`Address not found: ${id}`));
        deleteAddress(resolvedId);
        console.log(chalk.green(`✓ Address removed: ${addr!.email}`));
      } catch (e) {
        handleError(e);
      }
    });
}
