import type { Command } from "commander";
import chalk from "chalk";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../../db/domains.js";
import { getProvider } from "../../db/providers.js";
import { getAdapter } from "../../providers/index.js";
import { formatDnsTable } from "../../lib/dns.js";
import { colorDnsStatus, truncate, formatDate, tableRow } from "../../lib/format.js";
import { confirmDestructiveAction, handleError, resolveId } from "../utils.js";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { formatWarmingStatus, generateWarmingPlan, getTodayLimit, getTodaySentCount } from "../../lib/warming.js";

export function registerDomainCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const domainCmd = program.command("domain").description("Manage sending domains");

  domainCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .action(async (domain: string, opts: { provider: string }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);

        const d = createDomain(providerId, domain);
        console.log(chalk.green(`✓ Domain added: ${domain} (${d.id.slice(0, 8)})`));
        console.log(chalk.dim("Run 'emails domain dns <domain>' to see required DNS records."));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("list")
    .description("List domains")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const domains = listDomains(providerId);
        if (domains.length === 0) {
          output([], chalk.dim("No domains configured."));
          return;
        }
        const lines: string[] = [chalk.bold("\nDomains:")];
        for (const d of domains) {
          const dkim = colorDnsStatus(d.dkim_status);
          const spf = colorDnsStatus(d.spf_status);
          const dmarc = colorDnsStatus(d.dmarc_status);
          lines.push(`  ${chalk.cyan(d.id.slice(0, 8))}  ${d.domain}  DKIM:${dkim}  SPF:${spf}  DMARC:${dmarc}`);
        }
        lines.push("");
        output(domains, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("dns <domain>")
    .description("Show DNS records for a domain")
    .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        let providerId: string | undefined;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        }

        // Find domain in DB
        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);

        if (found) {
          const provider = getProvider(found.provider_id);
          if (provider) {
            const adapter = getAdapter(provider);
            const records = await adapter.getDnsRecords(domain);
            output(records, chalk.bold(`\nDNS Records for ${domain}:\n`) + formatDnsTable(records));
            return;
          }
        }

        // Fallback: generate generic records
        const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
        const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
        output(records, chalk.bold(`\nDNS Records for ${domain} (generic):\n`) + formatDnsTable(records));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status")
    .option("--provider <id>", "Provider ID")
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);
        if (!found) handleError(new Error(`Domain not found: ${domain}`));

        const provider = getProvider(found!.provider_id);
        if (!provider) handleError(new Error("Provider not found"));

        const adapter = getAdapter(provider!);
        const status = await adapter.verifyDomain(domain);
        updateDnsStatus(found!.id, status.dkim, status.spf, status.dmarc);

        console.log(chalk.bold(`\nDNS Status for ${domain}:`));
        console.log(`  DKIM:  ${colorDnsStatus(status.dkim)}`);
        console.log(`  SPF:   ${colorDnsStatus(status.spf)}`);
        console.log(`  DMARC: ${colorDnsStatus(status.dmarc)}`);
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("status")
    .description("Show domain status summary table")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const domains = listDomains(providerId);
        if (domains.length === 0) {
          output([], chalk.dim("No domains configured."));
          return;
        }
        const lines: string[] = [""];
        lines.push(tableRow(
          [chalk.bold("Domain"), 16],
          [chalk.bold("Provider"), 12],
          [chalk.bold("DKIM"), 12],
          [chalk.bold("SPF"), 12],
          [chalk.bold("DMARC"), 12],
          [chalk.bold("Last Verified"), 18],
        ));
        for (const d of domains) {
          const provider = getProvider(d.provider_id);
          const providerName = provider ? truncate(provider.name, 12) : d.provider_id.slice(0, 8);
          const lastVerified = d.verified_at ? formatDate(d.verified_at) : chalk.dim("never");
          lines.push(tableRow(
            [truncate(d.domain, 16), 16],
            [providerName, 12],
            [colorDnsStatus(d.dkim_status), 12],
            [colorDnsStatus(d.spf_status), 12],
            [colorDnsStatus(d.dmarc_status), 12],
            [lastVerified, 18],
          ));
        }
        lines.push("");
        output(domains, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("remove <id>")
    .description("Remove a domain")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveId("domains", id);
        const domain = getDomain(resolvedId);
        if (!domain) handleError(new Error(`Domain not found: ${id}`));
        await confirmDestructiveAction(`Remove domain ${domain.domain}?`, opts.yes);
        deleteDomain(resolvedId);
        console.log(chalk.green(`✓ Domain removed: ${domain.domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("check <domain>")
    .description("Live DNS check — verify actual DNS records against expected")
    .option("--provider <id>", "Provider ID")
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        const { checkDnsRecords, formatDnsCheck } = await import("../../lib/dns-check.js");

        let providerId: string | undefined;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        }

        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);

        let expectedRecords;
        if (found) {
          const provider = getProvider(found.provider_id);
          if (provider) {
            const adapter = getAdapter(provider);
            expectedRecords = await adapter.getDnsRecords(domain);
          }
        }

        if (!expectedRecords) {
          const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
          expectedRecords = [generateSpfRecord(domain), generateDmarcRecord(domain)];
        }

        console.log(chalk.bold(`\nDNS Check for ${domain}:`));
        const results = await checkDnsRecords(domain, expectedRecords);
        console.log(formatDnsCheck(results));

        const allMatch = results.every((r) => r.match);
        if (allMatch) {
          console.log(chalk.green("All DNS records verified successfully."));
        } else {
          const missing = results.filter((r) => !r.match).length;
          console.log(chalk.yellow(`${missing} record(s) not yet propagated or missing.`));
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  // ─── WARMING COMMANDS ──────────────────────────────────────────────────────

  domainCmd
    .command("setup-cloudflare <domain>")
    .description("Auto-create DNS records in Cloudflare for email sending (DKIM, SPF, DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--cloudflare-token <token>", "Cloudflare API token (falls back to config/env)")
    .option("--mx", "Also add MX record for receiving email")
    .option("--mx-server <host>", "Custom MX server hostname")
    .option("--register-ses", "Register the domain with SES first if not already added")
    .action(async (domain: string, opts: {
      provider: string;
      cloudflareToken?: string;
      mx?: boolean;
      mxServer?: string;
      registerSes?: boolean;
    }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        // Optionally register with SES first
        if (opts.registerSes) {
          console.log(chalk.dim(`Registering ${domain} with ${provider!.type.toUpperCase()}...`));
          const adapter = getAdapter(provider!);
          await adapter.addDomain(domain);
          const { createDomain } = await import("../../db/domains.js");
          createDomain(providerId, domain);
          console.log(chalk.green(`  ✓ Domain registered with ${provider!.type.toUpperCase()}`));
        }

        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");

        console.log(chalk.dim(`Setting up DNS records in Cloudflare for ${domain}...`));
        const result = await setupEmailDns({
          domain,
          provider: provider!,
          apiToken: opts.cloudflareToken,
          addMx: opts.mx,
          mxServer: opts.mxServer,
        });

        console.log(chalk.bold(`\nCloudflare DNS setup for ${domain}:`));
        console.log(chalk.dim(`  Zone: ${result.zone_name} (${result.zone_id})\n`));

        for (const r of result.records) {
          const icon = r.status === "created" ? chalk.green("✓")
            : r.status === "skipped" ? chalk.dim("–")
            : chalk.red("✗");
          const label = r.status === "skipped" ? chalk.dim("already exists") : "";
          const err = r.error ? chalk.red(` (${r.error})`) : "";
          console.log(`  ${icon} ${r.type.padEnd(6)} ${r.name}${label}${err}`);
        }

        console.log(`\n  Created: ${chalk.green(String(result.created))}  Skipped: ${chalk.dim(String(result.skipped))}${result.failed > 0 ? `  Failed: ${chalk.red(String(result.failed))}` : ""}`);

        if (result.created > 0) {
          console.log(chalk.dim(`\n  DNS changes may take a few minutes to propagate.`));
          console.log(chalk.dim(`  Verify with: emails domain verify ${domain} --provider ${opts.provider}`));
        }
        console.log();
        output(result, "");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm <domain>")
    .description("Start a warming schedule for a domain")
    .requiredOption("--target <n>", "Target daily send volume", parseInt)
    .option("--start-date <YYYY-MM-DD>", "Start date (default: today)")
    .option("--provider <id>", "Provider ID to associate")
    .action((domain: string, opts: { target: number; startDate?: string; provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const schedule = createWarmingSchedule({
          domain,
          provider_id: providerId,
          target_daily_volume: opts.target,
          start_date: opts.startDate,
        });
        console.log(chalk.green(`✓ Warming schedule created for ${domain}`));
        console.log(formatWarmingStatus(schedule));
        const plan = generateWarmingPlan(opts.target);
        console.log(chalk.dim(`\nWill reach target (${opts.target}/day) in ${plan[plan.length - 1]?.day ?? "?"} days`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-status <domain>")
    .description("Show warming schedule status for a domain")
    .action((domain: string) => {
      try {
        const schedule = getWarmingSchedule(domain);
        if (!schedule) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log("\n" + formatWarmingStatus(schedule) + "\n");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-list")
    .description("List all domain warming schedules")
    .option("--status <status>", "Filter by status (active, paused, completed)")
    .action((opts: { status?: string }) => {
      try {
        const schedules = listWarmingSchedules(opts.status);
        if (schedules.length === 0) {
          console.log(chalk.dim("No warming schedules found."));
          return;
        }
        console.log("");
        console.log(tableRow(
          [chalk.bold("Domain"), 20],
          [chalk.bold("Status"), 10],
          [chalk.bold("Start Date"), 12],
          [chalk.bold("Target"), 10],
          [chalk.bold("Today's Limit"), 14],
          [chalk.bold("Sent Today"), 12],
        ));
        for (const s of schedules) {
          const todayLimit = getTodayLimit(s);
          const todaySent = getTodaySentCount(s.domain);
          const statusColor = s.status === "active" ? chalk.green(s.status)
            : s.status === "paused" ? chalk.yellow(s.status)
            : chalk.dim(s.status);
          console.log(tableRow(
            [truncate(s.domain, 20), 20],
            [statusColor, 10],
            [s.start_date, 12],
            [String(s.target_daily_volume), 10],
            [todayLimit !== null ? String(todayLimit) : chalk.dim("n/a"), 14],
            [String(todaySent), 12],
          ));
        }
        console.log("");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-pause <domain>")
    .description("Pause a domain warming schedule")
    .action((domain: string) => {
      try {
        const updated = updateWarmingStatus(domain, "paused");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.yellow(`⏸ Warming schedule paused for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-resume <domain>")
    .description("Resume a paused domain warming schedule")
    .action((domain: string) => {
      try {
        const updated = updateWarmingStatus(domain, "active");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.green(`▶ Warming schedule resumed for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-complete <domain>")
    .description("Mark a domain warming schedule as completed")
    .action((domain: string) => {
      try {
        const updated = updateWarmingStatus(domain, "completed");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.green(`✓ Warming schedule marked complete for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DOMAIN PURCHASING (via @hasna/domains / Route 53) ───────────────────

  domainCmd
    .command("available <domain>")
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

  domainCmd
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
        if (!avail.available) { console.error(chalk.red(`✗ ${domain} is not available`)); process.exit(1); }
        const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
        console.log(chalk.green(`  ✓ Available${price}`));
        const result = await r53RegisterDomain(domain, {
          first_name: opts.firstName, last_name: opts.lastName,
          email: opts.email, phone: opts.phone,
          address_line_1: opts.address, city: opts.city,
          state: opts.state, country_code: opts.country,
          zip_code: opts.zip, organization_name: opts.org,
        }, parseInt(opts.years));
        console.log(chalk.green(`✓ Registration submitted for ${domain}`));
        console.log(chalk.dim(`  Operation ID: ${result.operationId}`));
        console.log(chalk.dim(`  Check status: emails domain purchase-status ${result.operationId}`));
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("purchase-status <operationId>")
    .description("Check domain registration/purchase status")
    .action(async (operationId: string) => {
      try {
        const { r53GetRegistrationStatus } = await import("@hasna/domains");
        const result = await r53GetRegistrationStatus(operationId);
        const color = result.status === "SUCCESSFUL" ? chalk.green : result.status === "FAILED" ? chalk.red : chalk.yellow;
        console.log(`Status: ${color(result.status)}`);
        if (result.domain) console.log(`Domain: ${result.domain}`);
        if (result.message) console.log(`Message: ${result.message}`);
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("list-registered")
    .description("List domains registered in Route 53")
    .action(async () => {
      try {
        const { r53ListRegisteredDomains } = await import("@hasna/domains");
        const domains = await r53ListRegisteredDomains();
        if (domains.length === 0) { output([], chalk.dim("No domains registered in Route 53.")); return; }
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

  domainCmd
    .command("setup <domain>")
    .description("Full setup: buy + Route 53 zone + register with SES + configure DNS (DKIM/SPF/DMARC)")
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
        const { r53CheckAvailability, r53RegisterDomain, r53CreateHostedZone, r53FindHostedZoneByDomain, r53UpsertRecords } = await import("@hasna/domains");
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const steps = opts.skipBuy ? 2 : 3;
        let step = 0;

        if (!opts.skipBuy) {
          step++;
          console.log(chalk.dim(`[${step}/${steps}] Checking and registering domain...`));
          const avail = await r53CheckAvailability(domain);
          if (!avail.available) handleError(new Error(`${domain} is not available`));
          const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
          console.log(chalk.green(`  ✓ Available${price}`));
          const reg = await r53RegisterDomain(domain, {
            first_name: opts.firstName, last_name: opts.lastName,
            email: opts.email, phone: opts.phone,
            address_line_1: opts.address, city: opts.city,
            state: opts.state, country_code: opts.country,
            zip_code: opts.zip, organization_name: opts.org,
          }, parseInt(opts.years));
          console.log(chalk.green(`  ✓ Registration submitted (op: ${reg.operationId})`));
        }

        step++;
        console.log(chalk.dim(`[${step}/${steps}] Setting up Route 53 hosted zone...`));
        let zone = await r53FindHostedZoneByDomain(domain);
        let nameServers: string[] = [];
        if (!zone) {
          const created = await r53CreateHostedZone(domain, `Email sending for ${domain}`);
          zone = created;
          nameServers = (created as { name_servers?: string[] }).name_servers ?? [];
          console.log(chalk.green(`  ✓ Hosted zone created (${zone.id})`));
        } else {
          console.log(chalk.green(`  ✓ Using existing zone (${zone.id})`));
        }

        step++;
        console.log(chalk.dim(`[${step}/${steps}] Registering with SES and configuring DNS records...`));
        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        createDomain(providerId, domain);
        const dnsRecords = await adapter.getDnsRecords(domain);
        const r53Records = dnsRecords.map((r) => ({
          name: r.name, type: r.type, ttl: 300,
          values: r.type === "TXT" ? [`"${r.value}"`] : [r.value],
        }));
        await r53UpsertRecords(zone.id, r53Records);
        console.log(chalk.green(`  ✓ ${r53Records.length} DNS records created`));

        console.log(chalk.bold(`\n✓ Setup complete for ${domain}`));
        if (nameServers.length > 0) {
          console.log(chalk.bold("\n  Name servers (point your registrar here):"));
          for (const ns of nameServers) console.log(chalk.cyan(`    ${ns}`));
        }
        console.log(chalk.dim(`\n  Verify: emails domain verify ${domain} --provider ${opts.provider}`));
        console.log();
      } catch (e) { handleError(e); }
    });
}
