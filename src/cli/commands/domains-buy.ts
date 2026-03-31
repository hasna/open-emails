/**
 * Domain purchasing & DNS setup commands for open-emails.
 *
 * Delegates domain registration and hosted zone management to @hasna/domains
 * (which wraps AWS Route 53 Domains + Route 53 DNS), then wires the domain
 * into SES for email sending automatically.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { handleError, resolveId } from "../utils.js";
import { getProvider } from "../../db/providers.js";
import { createDomain, listDomains } from "../../db/domains.js";
import { getAdapter } from "../../providers/index.js";

export function registerDomainsBuyCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const domainsBuyCmd = program
    .command("domains")
    .description("Purchase and manage email domains via AWS Route 53");

  // ─── CHECK AVAILABILITY ──────────────────────────────────────────────────

  domainsBuyCmd
    .command("check <domain>")
    .description("Check if a domain is available for purchase and get pricing")
    .action(async (domain: string) => {
      try {
        const { r53CheckAvailability } = await import("@hasna/domains");
        const result = await r53CheckAvailability(domain);
        if (result.available) {
          const price = result.price ? chalk.green(` — ${result.currency ?? "USD"} ${result.price}/yr`) : "";
          console.log(chalk.green(`✓ ${domain} is available${price}`));
        } else {
          console.log(chalk.red(`✗ ${domain} is not available`));
        }
        output(result, "");
      } catch (e) { handleError(e); }
    });

  // ─── BUY DOMAIN ─────────────────────────────────────────────────────────

  domainsBuyCmd
    .command("buy <domain>")
    .description("Purchase a domain via Route 53")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone in E.164 format (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .requiredOption("--state <state>", "State/province")
    .requiredOption("--country <code>", "Two-letter country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP/postal code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .action(async (domain: string, opts: {
      email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state: string;
      country: string; zip: string; org?: string; years: string;
    }) => {
      try {
        const { r53CheckAvailability, r53RegisterDomain } = await import("@hasna/domains");

        console.log(chalk.dim(`Checking availability of ${domain}...`));
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) {
          console.error(chalk.red(`✗ ${domain} is not available`));
          process.exit(1);
        }
        const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
        console.log(chalk.green(`  ✓ Available${price}`));

        console.log(chalk.dim("Submitting registration..."));
        const result = await r53RegisterDomain(domain, {
          first_name: opts.firstName,
          last_name: opts.lastName,
          email: opts.email,
          phone: opts.phone,
          address_line_1: opts.address,
          city: opts.city,
          state: opts.state,
          country_code: opts.country,
          zip_code: opts.zip,
          organization_name: opts.org,
        }, parseInt(opts.years));

        console.log(chalk.green(`✓ Registration submitted for ${domain}`));
        console.log(chalk.dim(`  Operation ID: ${result.operationId}`));
        console.log(chalk.dim(`  Check status: emails domains status ${result.operationId}`));
        output(result, "");
      } catch (e) { handleError(e); }
    });

  // ─── REGISTRATION STATUS ─────────────────────────────────────────────────

  domainsBuyCmd
    .command("status <operationId>")
    .description("Check domain registration status")
    .action(async (operationId: string) => {
      try {
        const { r53GetRegistrationStatus } = await import("@hasna/domains");
        const result = await r53GetRegistrationStatus(operationId);
        const color = result.status === "SUCCESSFUL" ? chalk.green
          : result.status === "FAILED" ? chalk.red : chalk.yellow;
        console.log(`Status: ${color(result.status)}`);
        if (result.domain) console.log(`Domain: ${result.domain}`);
        if (result.message) console.log(`Message: ${result.message}`);
        output(result, "");
      } catch (e) { handleError(e); }
    });

  // ─── LIST REGISTERED ─────────────────────────────────────────────────────

  domainsBuyCmd
    .command("list")
    .description("List domains registered in Route 53")
    .action(async () => {
      try {
        const { r53ListRegisteredDomains } = await import("@hasna/domains");
        const domains = await r53ListRegisteredDomains();
        if (domains.length === 0) {
          output([], chalk.dim("No domains registered in Route 53."));
          return;
        }
        const lines = [chalk.bold("\nRegistered domains:")];
        for (const d of domains) {
          const expiry = d.expiry ? chalk.dim(` — expires ${d.expiry.split("T")[0]}`) : "";
          const renew = d.auto_renew ? chalk.green(" [auto-renew]") : "";
          lines.push(`  ${chalk.cyan(d.domain)}${expiry}${renew}`);
        }
        lines.push("");
        output(domains, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  // ─── FULL SETUP ───────────────────────────────────────────────────────────

  domainsBuyCmd
    .command("setup <domain>")
    .description("Full setup: buy domain + create Route 53 zone + register with SES + configure all DNS")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .requiredOption("--state <state>", "State/province")
    .requiredOption("--country <code>", "Country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .option("--skip-buy", "Skip domain purchase (domain already registered)")
    .action(async (domain: string, opts: {
      provider: string; email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state: string;
      country: string; zip: string; org?: string; years: string; skipBuy?: boolean;
    }) => {
      try {
        const { r53CheckAvailability, r53RegisterDomain, r53CreateHostedZone, r53FindHostedZoneByDomain } = await import("@hasna/domains");
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        const steps = opts.skipBuy ? 3 : 4;
        let step = 0;

        // 1. Buy domain
        if (!opts.skipBuy) {
          step++;
          console.log(chalk.dim(`[${step}/${steps}] Checking availability...`));
          const avail = await r53CheckAvailability(domain);
          if (!avail.available) handleError(new Error(`${domain} is not available`));
          const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
          console.log(chalk.green(`  ✓ Available${price}`));

          step++;
          console.log(chalk.dim(`[${step}/${steps}] Registering domain...`));
          const reg = await r53RegisterDomain(domain, {
            first_name: opts.firstName, last_name: opts.lastName,
            email: opts.email, phone: opts.phone,
            address_line_1: opts.address, city: opts.city,
            state: opts.state, country_code: opts.country,
            zip_code: opts.zip, organization_name: opts.org,
          }, parseInt(opts.years));
          console.log(chalk.green(`  ✓ Submitted (op: ${reg.operationId})`));
        }

        // 2. Create hosted zone (find existing or create new)
        step++;
        console.log(chalk.dim(`[${step}/${steps}] Setting up Route 53 hosted zone...`));
        let zone = await r53FindHostedZoneByDomain(domain);
        let nameServers: string[] = [];
        if (!zone) {
          const created = await r53CreateHostedZone(domain, `Email sending for ${domain}`);
          zone = created;
          nameServers = created.name_servers ?? [];
          console.log(chalk.green(`  ✓ Hosted zone created (${zone.id})`));
        } else {
          console.log(chalk.green(`  ✓ Using existing zone (${zone.id})`));
        }

        // 3. Register with SES + configure DNS
        step++;
        console.log(chalk.dim(`[${step}/${steps}] Registering with SES and configuring DNS...`));
        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        createDomain(providerId, domain);

        // Get DNS records from SES and create them in Route 53
        const dnsRecords = await adapter.getDnsRecords(domain);
        const { r53UpsertRecords } = await import("@hasna/domains");
        const r53Records = dnsRecords.map((r) => ({
          name: r.name, type: r.type,
          ttl: 300,
          values: r.type === "TXT" ? [`"${r.value}"`] : [r.value],
        }));
        await r53UpsertRecords(zone.id, r53Records);
        console.log(chalk.green(`  ✓ ${r53Records.length} DNS records created`));

        // Summary
        console.log(chalk.bold(`\n✓ Setup complete for ${domain}`));
        if (nameServers.length > 0) {
          console.log(chalk.bold("\n  Name servers (point your registrar here):"));
          for (const ns of nameServers) console.log(chalk.cyan(`    ${ns}`));
        }
        console.log(chalk.dim(`\n  Verify DNS: emails domain verify ${domain} --provider ${opts.provider}`));
        console.log();
      } catch (e) { handleError(e); }
    });
}
