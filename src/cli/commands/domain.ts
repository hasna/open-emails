import type { Command } from "commander";
import chalk from "chalk";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../../db/domains.js";
import { getProvider } from "../../db/providers.js";
import { getAdapter } from "../../providers/index.js";
import { formatDnsTable } from "../../lib/dns.js";
import { colorDnsStatus, truncate, formatDate, tableRow } from "../../lib/format.js";
import { handleError, resolveId } from "../utils.js";

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
    .action((id: string) => {
      try {
        const resolvedId = resolveId("domains", id);
        const domain = getDomain(resolvedId);
        if (!domain) handleError(new Error(`Domain not found: ${id}`));
        deleteDomain(resolvedId);
        console.log(chalk.green(`✓ Domain removed: ${domain!.domain}`));
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
}
