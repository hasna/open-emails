#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createProvider, listProviders, deleteProvider, getProvider, updateProvider } from "../db/providers.js";
import { listSandboxEmails, getSandboxEmail, clearSandboxEmails, getSandboxCount } from "../db/sandbox.js";
import { listInboundEmails, getInboundEmail, clearInboundEmails, getInboundCount } from "../db/inbound.js";
import { createSmtpServer } from "../lib/inbound.js";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../db/addresses.js";
import { createEmail, listEmails, getEmail, searchEmails } from "../db/emails.js";
import { createTemplate, listTemplates, getTemplate, deleteTemplate, renderTemplate } from "../db/templates.js";
import { storeEmailContent, getEmailContent } from "../db/email-content.js";
import { listContacts, suppressContact, unsuppressContact, isContactSuppressed, incrementSendCount } from "../db/contacts.js";
import { createScheduledEmail, listScheduledEmails, cancelScheduledEmail, getDueEmails, markSent, markFailed } from "../db/scheduled.js";
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMembers, getMemberCount } from "../db/groups.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { batchSend } from "../lib/batch.js";
import { sendWithFailover } from "../lib/send.js";
import { formatDnsTable } from "../lib/dns.js";
import { getLocalStats, formatStatsTable } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";
import { checkAllProviders, formatProviderHealth } from "../lib/health.js";
import { loadConfig, getConfigValue, setConfigValue, getDefaultProviderId } from "../lib/config.js";
import { colorStatus, colorDnsStatus, colorProvider, truncate, formatDate, tableRow } from "../lib/format.js";
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "../lib/export.js";
import { setLogLevel, log } from "../lib/logger.js";
import { getAnalytics, formatAnalytics } from "../lib/analytics.js";
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from "../lib/completion.js";
import { runDiagnostics, formatDiagnostics } from "../lib/doctor.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

function handleError(e: unknown): never {
  console.error(chalk.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    console.error(chalk.red(`Could not resolve ID: ${partialId}`));
    process.exit(1);
  }
  return id;
}

program
  .name("emails")
  .description("Email management CLI — Resend, AWS SES, and Gmail")
  .version(getPackageVersion())
  .option("--json", "Output JSON instead of formatted text")
  .option("-q, --quiet", "Suppress info output")
  .option("-v, --verbose", "Show debug info")
  .hook("preAction", () => {
    const opts = program.opts();
    setLogLevel(!!opts.quiet, !!opts.verbose);
  });

function output(data: unknown, formatted: string): void {
  const opts = program.opts();
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatted);
  }
}

// ─── PROVIDER ─────────────────────────────────────────────────────────────────

const providerCmd = program.command("provider").description("Manage email providers");

providerCmd
  .command("add")
  .description("Add an email provider (resend, ses, or gmail)")
  .requiredOption("--name <name>", "Provider name")
  .requiredOption("--type <type>", "Provider type: resend | ses | gmail")
  .option("--api-key <key>", "Resend API key")
  .option("--region <region>", "SES region")
  .option("--access-key <key>", "SES access key ID")
  .option("--secret-key <key>", "SES secret access key")
  .option("--client-id <id>", "Gmail OAuth client ID")
  .option("--client-secret <secret>", "Gmail OAuth client secret")
  .option("--skip-validation", "Skip credential validation after adding")
  .action(async (opts: {
    name: string;
    type: string;
    apiKey?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    clientId?: string;
    clientSecret?: string;
    skipValidation?: boolean;
  }) => {
    try {
      if (opts.type !== "resend" && opts.type !== "ses" && opts.type !== "gmail" && opts.type !== "sandbox") {
        handleError(new Error("Provider type must be 'resend', 'ses', 'gmail', or 'sandbox'"));
      }

      if (opts.type === "sandbox") {
        const provider = createProvider({ name: opts.name, type: "sandbox" });
        log.success(`✓ Sandbox provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
        log.info(chalk.dim("  Emails sent to this provider are captured locally — not delivered."));
        return;
      }

      if (opts.type === "gmail") {
        if (!opts.clientId) handleError(new Error("Gmail provider requires --client-id"));
        if (!opts.clientSecret) handleError(new Error("Gmail provider requires --client-secret"));

        const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
        log.info(chalk.dim("Starting Gmail OAuth flow..."));
        const tokens = await startGmailOAuthFlow(opts.clientId!, opts.clientSecret!);

        const provider = createProvider({
          name: opts.name,
          type: "gmail",
          oauth_client_id: opts.clientId,
          oauth_client_secret: opts.clientSecret,
          oauth_refresh_token: tokens.refresh_token,
          oauth_access_token: tokens.access_token,
          oauth_token_expiry: tokens.expiry,
        });

        if (!opts.skipValidation) {
          try {
            const adapter = getAdapter(provider);
            await adapter.listAddresses();
          } catch (validationErr) {
            deleteProvider(provider.id);
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
          }
        }

        log.success(`\u2713 Gmail provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
        return;
      }

      const provider = createProvider({
        name: opts.name,
        type: opts.type as "resend" | "ses",
        api_key: opts.apiKey,
        region: opts.region,
        access_key: opts.accessKey,
        secret_key: opts.secretKey,
      });

      if (!opts.skipValidation) {
        try {
          const adapter = getAdapter(provider);
          await adapter.listDomains();
        } catch (validationErr) {
          deleteProvider(provider.id);
          handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
        }
      }

      log.success(`\u2713 Provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("list")
  .description("List configured providers")
  .action(() => {
    try {
      const providers = listProviders();
      if (providers.length === 0) {
        output([], chalk.dim("No providers configured. Use 'emails provider add' to add one."));
        return;
      }
      const lines: string[] = [chalk.bold("\nProviders:")];
      for (const p of providers) {
        const status = colorProvider(p.active, p.active ? "active" : "inactive");
        lines.push(`  ${chalk.cyan(p.id.slice(0, 8))}  ${p.name}  [${p.type}]  ${status}`);
      }
      lines.push("");
      output(providers, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("remove <id>")
  .description("Remove a provider")
  .action((id: string) => {
    try {
      const resolvedId = resolveId("providers", id);
      const provider = getProvider(resolvedId);
      if (!provider) handleError(new Error(`Provider not found: ${id}`));
      deleteProvider(resolvedId);
      console.log(chalk.green(`✓ Provider removed: ${provider!.name}`));
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("auth <id>")
  .description("Re-authenticate a Gmail provider (refresh OAuth tokens)")
  .action(async (id: string) => {
    try {
      const resolvedId = resolveId("providers", id);
      const provider = getProvider(resolvedId);
      if (!provider) handleError(new Error(`Provider not found: ${id}`));
      if (provider!.type !== "gmail") {
        handleError(new Error("Only Gmail providers require OAuth re-authentication"));
      }
      if (!provider!.oauth_client_id || !provider!.oauth_client_secret) {
        handleError(new Error("Provider is missing oauth_client_id or oauth_client_secret"));
      }

      const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
      console.log(chalk.dim("Starting Gmail OAuth flow..."));
      const tokens = await startGmailOAuthFlow(provider!.oauth_client_id!, provider!.oauth_client_secret!);

      const { updateProvider } = await import("../db/providers.js");
      updateProvider(resolvedId, {
        oauth_refresh_token: tokens.refresh_token,
        oauth_access_token: tokens.access_token,
        oauth_token_expiry: tokens.expiry,
      });

      console.log(chalk.green(`✓ Gmail provider re-authenticated: ${provider!.name}`));
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("update <id>")
  .description("Update an existing provider")
  .option("--name <name>", "Provider name")
  .option("--api-key <key>", "Resend API key")
  .option("--region <region>", "SES region")
  .option("--access-key <key>", "SES access key ID")
  .option("--secret-key <key>", "SES secret access key")
  .option("--skip-validation", "Skip credential validation after update")
  .action(async (id: string, opts: {
    name?: string;
    apiKey?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    skipValidation?: boolean;
  }) => {
    try {
      const resolvedId = resolveId("providers", id);
      const existing = getProvider(resolvedId);
      if (!existing) handleError(new Error(`Provider not found: ${id}`));

      // Save original state for revert
      const original = { ...existing! };

      const updates: Record<string, string | undefined> = {};
      if (opts.name !== undefined) updates.name = opts.name;
      if (opts.apiKey !== undefined) updates.api_key = opts.apiKey;
      if (opts.region !== undefined) updates.region = opts.region;
      if (opts.accessKey !== undefined) updates.access_key = opts.accessKey;
      if (opts.secretKey !== undefined) updates.secret_key = opts.secretKey;

      const updated = updateProvider(resolvedId, updates);

      if (!opts.skipValidation) {
        try {
          const adapter = getAdapter(updated);
          if (updated.type === "gmail") {
            await adapter.listAddresses();
          } else {
            await adapter.listDomains();
          }
        } catch (validationErr) {
          // Revert the update
          updateProvider(resolvedId, {
            name: original.name,
            api_key: original.api_key ?? undefined,
            region: original.region ?? undefined,
            access_key: original.access_key ?? undefined,
            secret_key: original.secret_key ?? undefined,
            oauth_client_id: original.oauth_client_id ?? undefined,
            oauth_client_secret: original.oauth_client_secret ?? undefined,
            oauth_refresh_token: original.oauth_refresh_token ?? undefined,
            oauth_access_token: original.oauth_access_token ?? undefined,
            oauth_token_expiry: original.oauth_token_expiry ?? undefined,
          });
          handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Update was reverted.`));
        }
      }

      log.success(`\u2713 Provider updated: ${updated.name} (${updated.id.slice(0, 8)})`);
    } catch (e) {
      handleError(e);
    }
  });

providerCmd
  .command("status")
  .description("Health check all active providers")
  .action(async () => {
    try {
      const results = await checkAllProviders();
      if (results.length === 0) {
        output([], chalk.dim("No active providers. Add one with 'emails provider add'"));
        return;
      }
      const lines: string[] = [chalk.bold("\nProvider Health:\n")];
      for (const h of results) {
        lines.push(formatProviderHealth(h));
        lines.push("");
      }
      output(results, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

// ─── DOMAIN ───────────────────────────────────────────────────────────────────

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
      const { generateSpfRecord, generateDmarcRecord } = await import("../lib/dns.js");
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

// ─── ADDRESS ──────────────────────────────────────────────────────────────────

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

// ─── SEND ─────────────────────────────────────────────────────────────────────

program
  .command("send")
  .description("Send an email")
  .requiredOption("--from <email>", "Sender email address")
  .option("--to <email...>", "Recipient email address(es)")
  .option("--to-group <name>", "Send to all members of a recipient group")
  .option("--subject <subject>", "Email subject")
  .option("--body <text>", "Email body text")
  .option("--body-file <path>", "Read body from file")
  .option("--html", "Treat --body as HTML")
  .option("--cc <email...>", "CC recipients")
  .option("--bcc <email...>", "BCC recipients")
  .option("--reply-to <email>", "Reply-to address")
  .option("--attachment <path...>", "Attachment file path(s)")
  .option("--provider <id>", "Provider ID (uses first active if not specified)")
  .option("--template <name>", "Use a template by name")
  .option("--vars <json>", "Template variables as JSON string")
  .option("--force", "Send even if recipients are suppressed")
  .option("--schedule <datetime>", "Schedule email for later (ISO 8601 datetime)")
  .option("--unsubscribe-url <url>", "Inject List-Unsubscribe headers (RFC 8058 one-click)")
  .option("--idempotency-key <key>", "Prevent duplicate sends — returns existing email if key was used before")
  .action(async (opts: {
    from: string;
    to?: string[];
    toGroup?: string;
    subject?: string;
    body?: string;
    bodyFile?: string;
    html?: boolean;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    attachment?: string[];
    provider?: string;
    template?: string;
    vars?: string;
    force?: boolean;
    schedule?: string;
  }) => {
    try {
      const db = getDatabase();

      // Resolve recipients from --to or --to-group
      let toAddresses: string[] = opts.to || [];
      if (opts.toGroup) {
        const group = getGroupByName(opts.toGroup, db);
        if (!group) handleError(new Error(`Group not found: ${opts.toGroup}`));
        const members = listMembers(group!.id, db);
        if (members.length === 0) handleError(new Error(`Group '${opts.toGroup}' has no members`));
        toAddresses = members.map(m => m.email);
      }
      if (toAddresses.length === 0) handleError(new Error("No recipients specified. Use --to or --to-group"));

      // Check suppressed contacts
      const allRecipients = [...toAddresses, ...(opts.cc || []), ...(opts.bcc || [])];
      const suppressedRecipients = allRecipients.filter((email) => isContactSuppressed(email, db));
      if (suppressedRecipients.length > 0 && !opts.force) {
        console.log(chalk.yellow(`Warning: Suppressed recipients: ${suppressedRecipients.join(", ")}`));
        console.log(chalk.dim("  Use --force to send anyway."));
      }

      // Resolve body from --body, --body-file, or stdin pipe
      let body = opts.body;
      if (opts.bodyFile) {
        body = readFileSync(opts.bodyFile, "utf-8");
      } else if (!body && !opts.template && !process.stdin.isTTY) {
        body = await new Promise<string>((resolve) => {
          let data = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (chunk: string) => data += chunk);
          process.stdin.on("end", () => resolve(data));
        });
      }

      // Resolve template
      let subject = opts.subject || "";
      let htmlBody = opts.html ? body : undefined;
      let textBody = !opts.html ? body : undefined;

      if (opts.template) {
        const tpl = getTemplate(opts.template, db);
        if (!tpl) handleError(new Error(`Template not found: ${opts.template}`));
        const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};
        subject = renderTemplate(tpl!.subject_template, vars);
        if (tpl!.html_template) htmlBody = renderTemplate(tpl!.html_template, vars);
        if (tpl!.text_template) textBody = renderTemplate(tpl!.text_template, vars);
      }

      if (!subject) handleError(new Error("Subject is required (use --subject or --template)"));

      let providerId: string;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      } else {
        const providers = listProviders(db).filter((p) => p.active);
        if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
        providerId = providers[0]!.id;
      }

      const provider = getProvider(providerId, db);
      if (!provider) handleError(new Error(`Provider not found: ${providerId}`));

      // Read attachments
      const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB (Resend/SES limit)
      const MAX_ATTACHMENT_COUNT = 10;
      const attachments = [];
      if (opts.attachment) {
        if (opts.attachment.length > MAX_ATTACHMENT_COUNT) {
          handleError(new Error(`Too many attachments: ${opts.attachment.length} (max ${MAX_ATTACHMENT_COUNT})`));
        }
        const { readFileSync, statSync } = await import("node:fs");
        const { basename, extname } = await import("node:path");
        for (const path of opts.attachment) {
          const stat = statSync(path);
          if (stat.size > MAX_ATTACHMENT_SIZE) {
            handleError(new Error(`Attachment "${basename(path)}" is too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`));
          }
          const content = readFileSync(path);
          const ext = extname(path).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".pdf": "application/pdf",
            ".txt": "text/plain",
            ".html": "text/html",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".zip": "application/zip",
            ".csv": "text/csv",
            ".json": "application/json",
          };
          attachments.push({
            filename: basename(path),
            content: content.toString("base64"),
            content_type: mimeTypes[ext] ?? "application/octet-stream",
          });
        }
      }

      // Handle scheduling
      if (opts.schedule) {
        const scheduled = createScheduledEmail({
          provider_id: providerId,
          from_address: opts.from,
          to_addresses: toAddresses,
          cc_addresses: opts.cc,
          bcc_addresses: opts.bcc,
          reply_to: opts.replyTo,
          subject,
          html: htmlBody,
          text_body: textBody,
          attachments_json: attachments.length > 0 ? attachments : undefined,
          template_name: opts.template,
          template_vars: opts.vars ? JSON.parse(opts.vars) : undefined,
          scheduled_at: opts.schedule,
        }, db);
        console.log(chalk.green(`✓ Email scheduled for ${opts.schedule}`));
        console.log(chalk.dim(`  Scheduled ID: ${scheduled.id.slice(0, 8)}`));
        return;
      }

      const sendOpts = {
        provider_id: providerId,
        from: opts.from,
        to: toAddresses,
        cc: opts.cc,
        bcc: opts.bcc,
        reply_to: opts.replyTo,
        subject,
        text: textBody,
        html: htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
        unsubscribe_url: (opts as Record<string, unknown>).unsubscribeUrl as string | undefined,
        idempotency_key: (opts as Record<string, unknown>).idempotencyKey as string | undefined,
      };

      const { messageId, providerId: actualProviderId, usedFailover } = await sendWithFailover(providerId, sendOpts, db);
      if (usedFailover) log.info(chalk.yellow(`  (Used failover provider)`));

      const email = createEmail(actualProviderId, sendOpts, messageId, db);

      // Store email content
      storeEmailContent(email.id, { html: htmlBody, text: textBody }, db);

      // Track contacts
      for (const recipientEmail of allRecipients) {
        incrementSendCount(recipientEmail, db);
      }

      console.log(chalk.green(`✓ Email sent to ${toAddresses.join(", ")}`));
      if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── TEMPLATE ────────────────────────────────────────────────────────────────

const templateCmd = program.command("template").description("Manage email templates");

templateCmd
  .command("add <name>")
  .description("Add an email template")
  .requiredOption("--subject <subject>", "Subject template (supports {{var}} placeholders)")
  .option("--html <html>", "Inline HTML template")
  .option("--text <text>", "Inline text template")
  .option("--html-file <path>", "Read HTML template from file")
  .option("--text-file <path>", "Read text template from file")
  .action((name: string, opts: { subject: string; html?: string; text?: string; htmlFile?: string; textFile?: string }) => {
    try {
      let htmlTemplate = opts.html;
      let textTemplate = opts.text;

      if (opts.htmlFile) {
        htmlTemplate = readFileSync(opts.htmlFile, "utf-8");
      }
      if (opts.textFile) {
        textTemplate = readFileSync(opts.textFile, "utf-8");
      }

      const template = createTemplate({
        name,
        subject_template: opts.subject,
        html_template: htmlTemplate,
        text_template: textTemplate,
      });
      console.log(chalk.green(`✓ Template created: ${template.name} (${template.id.slice(0, 8)})`));
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("list")
  .description("List all templates")
  .action(() => {
    try {
      const templates = listTemplates();
      if (templates.length === 0) {
        output([], chalk.dim("No templates configured. Use 'emails template add' to create one."));
        return;
      }
      const tplLines: string[] = [chalk.bold("\nTemplates:")];
      for (const t of templates) {
        const hasHtml = t.html_template ? chalk.green("html") : chalk.dim("no-html");
        const hasText = t.text_template ? chalk.green("text") : chalk.dim("no-text");
        tplLines.push(`  ${chalk.cyan(t.id.slice(0, 8))}  ${t.name}  subject="${truncate(t.subject_template, 30)}"  [${hasHtml}] [${hasText}]`);
      }
      tplLines.push("");
      output(templates, tplLines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("show <name>")
  .description("Show template details")
  .action((name: string) => {
    try {
      const template = getTemplate(name);
      if (!template) handleError(new Error(`Template not found: ${name}`));
      console.log(chalk.bold(`\nTemplate: ${template!.name}`));
      console.log(`  ID:      ${template!.id}`);
      console.log(`  Subject: ${template!.subject_template}`);
      if (template!.html_template) {
        console.log(`  HTML:    ${truncate(template!.html_template, 60)}`);
      }
      if (template!.text_template) {
        console.log(`  Text:    ${truncate(template!.text_template, 60)}`);
      }
      console.log(`  Created: ${template!.created_at}`);
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

templateCmd
  .command("remove <name>")
  .description("Remove a template")
  .action((name: string) => {
    try {
      const deleted = deleteTemplate(name);
      if (!deleted) handleError(new Error(`Template not found: ${name}`));
      console.log(chalk.green(`✓ Template removed: ${name}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── CONTACTS ────────────────────────────────────────────────────────────────

const contactsCmd = program.command("contacts").description("Manage email contacts");

contactsCmd
  .command("list")
  .description("List contacts")
  .option("--suppressed", "Show only suppressed contacts")
  .action((opts: { suppressed?: boolean }) => {
    try {
      const contacts = listContacts(opts.suppressed !== undefined ? { suppressed: opts.suppressed } : undefined);
      if (contacts.length === 0) {
        output([], chalk.dim("No contacts tracked yet."));
        return;
      }
      const cLines: string[] = [chalk.bold("\nContacts:")];
      for (const c of contacts) {
        const suppressed = c.suppressed ? chalk.red("suppressed") : chalk.green("active");
        const name = c.name ? ` (${c.name})` : "";
        cLines.push(`  ${c.email}${name}  sent:${c.send_count} bounce:${c.bounce_count} complaint:${c.complaint_count}  [${suppressed}]`);
      }
      cLines.push("");
      output(contacts, cLines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

contactsCmd
  .command("suppress <email>")
  .description("Suppress a contact (prevent sending)")
  .action((email: string) => {
    try {
      suppressContact(email);
      console.log(chalk.green(`✓ Contact suppressed: ${email}`));
    } catch (e) {
      handleError(e);
    }
  });

contactsCmd
  .command("unsuppress <email>")
  .description("Unsuppress a contact (allow sending again)")
  .action((email: string) => {
    try {
      unsuppressContact(email);
      console.log(chalk.green(`✓ Contact unsuppressed: ${email}`));
    } catch (e) {
      handleError(e);
    }
  });


// ─── SCHEDULED ──────────────────────────────────────────────────────────────

const scheduledCmd = program.command("scheduled").description("Manage scheduled emails");

scheduledCmd
  .command("list")
  .description("List scheduled emails")
  .option("--status <status>", "Filter by status: pending|sent|cancelled|failed")
  .action((opts: { status?: string }) => {
    try {
      const status = opts.status as "pending" | "sent" | "cancelled" | "failed" | undefined;
      const emails = listScheduledEmails(status ? { status } : undefined);
      if (emails.length === 0) {
        console.log(chalk.dim("No scheduled emails."));
        return;
      }
      console.log(chalk.bold("\nScheduled Emails:"));
      for (const e of emails) {
        const statusColor = e.status === "pending" ? chalk.blue(e.status) :
          e.status === "sent" ? chalk.green(e.status) :
          e.status === "cancelled" ? chalk.yellow(e.status) :
          chalk.red(e.status);
        console.log(`  ${chalk.cyan(e.id.slice(0, 8))}  ${e.subject}  -> ${e.to_addresses.join(", ")}  [${statusColor}]  at ${e.scheduled_at}`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

scheduledCmd
  .command("cancel <id>")
  .description("Cancel a scheduled email")
  .action((id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "scheduled_emails", id);
      if (!resolvedId) handleError(new Error(`Scheduled email not found: ${id}`));
      const cancelled = cancelScheduledEmail(resolvedId!, db);
      if (!cancelled) handleError(new Error(`Cannot cancel email ${id} (may already be sent or cancelled)`));
      console.log(chalk.green(`✓ Scheduled email cancelled: ${resolvedId!.slice(0, 8)}`));
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("scheduler")
  .description("Start the email scheduler")
  .option("--interval <duration>", "Poll interval (e.g. 30s, 1m, 5m)", "30s")
  .action(async (opts: { interval?: string }) => {
    try {
      const interval = parseDuration(opts.interval || "30s");
      console.log(chalk.blue(`Scheduler started. Polling every ${opts.interval || "30s"}...`));
      while (true) {
        const due = getDueEmails();
        for (const scheduled of due) {
          try {
            const provider = getProvider(scheduled.provider_id);
            if (!provider) {
              markFailed(scheduled.id, "Provider not found");
              continue;
            }
            const adapter = getAdapter(provider);
            const sendOpts = {
              from: scheduled.from_address,
              to: scheduled.to_addresses,
              cc: scheduled.cc_addresses.length > 0 ? scheduled.cc_addresses : undefined,
              bcc: scheduled.bcc_addresses.length > 0 ? scheduled.bcc_addresses : undefined,
              reply_to: scheduled.reply_to || undefined,
              subject: scheduled.subject,
              html: scheduled.html || undefined,
              text: scheduled.text_body || undefined,
            };
            const messageId = await adapter.sendEmail(sendOpts);
            createEmail(scheduled.provider_id, sendOpts, messageId);
            markSent(scheduled.id);
            console.log(chalk.green(`✓ Sent scheduled email ${scheduled.id.slice(0, 8)} to ${scheduled.to_addresses.join(", ")}`));
          } catch (err) {
            markFailed(scheduled.id, err instanceof Error ? err.message : String(err));
            console.log(chalk.red(`✗ Failed scheduled email ${scheduled.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        await new Promise(r => setTimeout(r, interval));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ─── GROUP ──────────────────────────────────────────────────────────────────

const groupCmd = program.command("group").description("Manage recipient groups");

groupCmd
  .command("create <name>")
  .description("Create a recipient group")
  .option("--description <text>", "Group description")
  .action((name: string, opts: { description?: string }) => {
    try {
      const group = createGroup(name, opts.description);
      console.log(chalk.green(`✓ Group created: ${group.name} (${group.id.slice(0, 8)})`));
    } catch (e) {
      handleError(e);
    }
  });

groupCmd
  .command("list")
  .description("List recipient groups")
  .action(() => {
    try {
      const groups = listGroups();
      if (groups.length === 0) {
        console.log(chalk.dim("No groups configured. Use 'emails group create' to add one."));
        return;
      }
      console.log(chalk.bold("\nGroups:"));
      for (const g of groups) {
        const count = getMemberCount(g.id);
        const desc = g.description ? chalk.dim(` — ${g.description}`) : "";
        console.log(`  ${chalk.cyan(g.id.slice(0, 8))}  ${g.name}  (${count} members)${desc}`);
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

groupCmd
  .command("show <name>")
  .description("Show group details and members")
  .action((name: string) => {
    try {
      const group = getGroupByName(name);
      if (!group) handleError(new Error(`Group not found: ${name}`));
      const members = listMembers(group!.id);
      console.log(chalk.bold(`
Group: ${group!.name}`));
      if (group!.description) console.log(chalk.dim(`  ${group!.description}`));
      console.log(`  Members (${members.length}):`);
      if (members.length === 0) {
        console.log(chalk.dim("    No members. Use 'emails group add' to add some."));
      } else {
        for (const m of members) {
          const displayName = m.name ? ` (${m.name})` : "";
          const vars = Object.keys(m.vars).length > 0 ? chalk.dim(` vars=${JSON.stringify(m.vars)}`) : "";
          console.log(`    ${m.email}${displayName}${vars}`);
        }
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

groupCmd
  .command("add <name> <emails...>")
  .description("Add members to a group")
  .option("--name <displayName>", "Display name for the member(s)")
  .action((name: string, emails: string[], opts: { name?: string }) => {
    try {
      const group = getGroupByName(name);
      if (!group) handleError(new Error(`Group not found: ${name}`));
      for (const email of emails) {
        addMember(group!.id, email, opts.name);
      }
      console.log(chalk.green(`✓ Added ${emails.length} member(s) to group '${name}'`));
    } catch (e) {
      handleError(e);
    }
  });

groupCmd
  .command("remove-member <name> <email>")
  .description("Remove a member from a group")
  .action((name: string, email: string) => {
    try {
      const group = getGroupByName(name);
      if (!group) handleError(new Error(`Group not found: ${name}`));
      const removed = removeMember(group!.id, email);
      if (!removed) handleError(new Error(`Member not found: ${email}`));
      console.log(chalk.green(`✓ Removed ${email} from group '${name}'`));
    } catch (e) {
      handleError(e);
    }
  });

groupCmd
  .command("delete <name>")
  .description("Delete a group")
  .action((name: string) => {
    try {
      const group = getGroupByName(name);
      if (!group) handleError(new Error(`Group not found: ${name}`));
      deleteGroup(group!.id);
      console.log(chalk.green(`✓ Group deleted: ${name}`));
    } catch (e) {
      handleError(e);
    }
  });

// ─── BATCH ──────────────────────────────────────────────────────────────────

program
  .command("batch")
  .description("Batch send emails from CSV")
  .requiredOption("--csv <path>", "Path to CSV file (must have 'email' column)")
  .requiredOption("--template <name>", "Template name to use")
  .requiredOption("--from <email>", "Sender email address")
  .option("--provider <id>", "Provider ID (uses first active if not specified)")
  .option("--force", "Send even to suppressed contacts")
  .action(async (opts: { csv: string; template: string; from: string; provider?: string; force?: boolean }) => {
    try {
      const db = getDatabase();

      let providerId: string;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      } else {
        const providers = listProviders(db).filter((p) => p.active);
        if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
        providerId = providers[0]!.id;
      }

      const provider = getProvider(providerId, db);
      if (!provider) handleError(new Error(`Provider not found: ${providerId}`));

      console.log(chalk.dim(`Batch sending with template '${opts.template}' from ${opts.from}...`));
      const result = await batchSend({
        csvPath: opts.csv,
        templateName: opts.template,
        from: opts.from,
        provider: provider!,
        force: opts.force,
      });

      console.log(chalk.bold("\nBatch Send Results:"));
      console.log(`  Total:      ${result.total}`);
      console.log(`  Sent:       ${chalk.green(String(result.sent))}`);
      console.log(`  Failed:     ${result.failed > 0 ? chalk.red(String(result.failed)) : "0"}`);
      console.log(`  Suppressed: ${result.suppressed > 0 ? chalk.yellow(String(result.suppressed)) : "0"}`);
      if (result.errors.length > 0) {
        console.log(chalk.bold("\n  Errors:"));
        for (const err of result.errors) {
          console.log(chalk.red(`    ${err.email}: ${err.error}`));
        }
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

// ─── PULL ─────────────────────────────────────────────────────────────────────

function parseDuration(str: string): number {
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

program
  .command("pull")
  .description("Sync events from provider(s)")
  .option("--provider <id>", "Provider ID (syncs all if not specified)")
  .option("--watch", "Keep syncing on an interval")
  .option("--interval <duration>", "Watch interval (e.g. 30s, 5m, 1h)", "5m")
  .action(async (opts: { provider?: string; watch?: boolean; interval?: string }) => {
    try {
      const runSync = async () => {
        if (opts.provider) {
          const providerId = resolveId("providers", opts.provider);
          const count = await syncProvider(providerId);
          return count;
        } else {
          const results = await syncAll();
          let total = 0;
          for (const [id, count] of Object.entries(results)) {
            if (!opts.watch) console.log(`  ${id.slice(0, 8)}: ${count} events`);
            total += count;
          }
          return total;
        }
      };

      if (opts.watch) {
        const interval = parseDuration(opts.interval || "5m");
        console.log(chalk.blue(`Watching for new events every ${opts.interval || "5m"}...`));
        while (true) {
          const total = await runSync();
          console.log(chalk.gray(`[${new Date().toLocaleTimeString()}]`) + ` Synced ${total} events`);
          await new Promise(r => setTimeout(r, interval));
        }
      } else {
        console.log(chalk.dim(opts.provider ? "Syncing events..." : "Syncing all providers..."));
        const total = await runSync();
        console.log(chalk.green(`✓ Synced ${total} events${opts.provider ? "" : " total"}`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ─── STATS ────────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show email delivery statistics")
  .option("--provider <id>", "Provider ID")
  .option("--period <period>", "Period: 7d, 30d, 90d", "30d")
  .action((opts: { provider?: string; period?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const stats = getLocalStats(providerId, opts.period ?? "30d");
      output(stats, chalk.bold("\nEmail Stats:\n") + formatStatsTable(stats));
    } catch (e) {
      handleError(e);
    }
  });

// ─── MONITOR ──────────────────────────────────────────────────────────────────

program
  .command("monitor")
  .description("Live monitor with auto-refresh")
  .option("--provider <id>", "Provider ID")
  .option("--interval <seconds>", "Refresh interval in seconds", "30")
  .action(async (opts: { provider?: string; interval?: string }) => {
    const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
    const intervalSec = parseInt(opts.interval ?? "30", 10);

    const render = () => {
      process.stdout.write("\x1Bc"); // Clear screen
      const now = new Date().toLocaleTimeString();
      console.log(chalk.bold(`Email Monitor  [${now}]  (Ctrl+C to exit)\n`));

      try {
        const stats = getLocalStats(providerId, "7d");
        console.log(chalk.bold("Last 7 days:"));
        console.log(`  ${chalk.cyan("Sent")}:       ${stats.sent}`);
        console.log(`  ${chalk.green("Delivered")}: ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`);
        console.log(`  ${chalk.red("Bounced")}:   ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`);
        console.log(`  ${chalk.yellow("Opened")}:    ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`);
        console.log();

        const emails = listEmails({ provider_id: providerId, limit: 5 });
        if (emails.length > 0) {
          console.log(chalk.bold("Recent emails:"));
          for (const e of emails) {
            const status = colorStatus(e.status);
            console.log(`  ${padRight(status, 12)}  ${truncate(e.subject, 40)}  \u2192 ${e.to_addresses[0] ?? ""}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
      }
    };

    render();
    const timer = setInterval(render, intervalSec * 1000);

    process.on("SIGINT", () => {
      clearInterval(timer);
      console.log("\n" + chalk.dim("Monitor stopped."));
      process.exit(0);
    });
  });

// ─── SERVE ────────────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the HTTP server and dashboard")
  .option("--port <port>", "Port to listen on", "3900")
  .action(async (opts: { port?: string }) => {
    const { startServer } = await import("../server/serve.js");
    const port = parseInt(opts.port ?? "3900", 10);
    await startServer(port);
  });

// ─── MCP ──────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Install/configure the MCP server")
  .option("--claude", "Install into Claude Code")
  .option("--codex", "Show Codex config snippet")
  .option("--gemini", "Show Gemini config snippet")
  .option("--uninstall", "Uninstall from Claude Code")
  .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; uninstall?: boolean }) => {
    if (opts.uninstall) {
      try {
        execSync("claude mcp remove emails", { stdio: "inherit" });
        console.log(chalk.green("✓ Uninstalled from Claude Code"));
      } catch (e) {
        handleError(e);
      }
      return;
    }

    if (opts.claude) {
      try {
        execSync("claude mcp add --transport stdio --scope user emails -- emails-mcp", {
          stdio: "inherit",
        });
        console.log(chalk.green("✓ Installed into Claude Code"));
      } catch (e) {
        handleError(e);
      }
      return;
    }

    if (opts.codex) {
      console.log(`\nAdd to ~/.codex/config.toml:\n`);
      console.log(`[mcp_servers.emails]`);
      console.log(`command = "emails-mcp"`);
      console.log(`args = []\n`);
      return;
    }

    if (opts.gemini) {
      console.log(`\nAdd to ~/.gemini/settings.json under mcpServers:\n`);
      console.log(JSON.stringify({ emails: { command: "emails-mcp", args: [] } }, null, 2));
      console.log();
      return;
    }

    program.help();
  });

// ─── EXPORT ──────────────────────────────────────────────────────────────────

program
  .command("export <type>")
  .description("Export emails or events (type: emails | events)")
  .option("--provider <id>", "Filter by provider ID")
  .option("--since <date>", "Filter from date (ISO)")
  .option("--until <date>", "Filter until date (ISO)")
  .option("--format <fmt>", "Output format: json | csv", "json")
  .option("--output <file>", "Write to file instead of stdout")
  .action((type: string, opts: { provider?: string; since?: string; until?: string; format?: string; output?: string }) => {
    try {
      if (type !== "emails" && type !== "events") {
        handleError(new Error("Export type must be 'emails' or 'events'"));
      }

      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const fmt = opts.format ?? "json";
      let result: string;

      if (type === "emails") {
        const filters = { provider_id: providerId, since: opts.since, until: opts.until };
        result = fmt === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
      } else {
        const filters = { provider_id: providerId, since: opts.since };
        result = fmt === "csv" ? exportEventsCsv(filters) : exportEventsJson(filters);
      }

      if (opts.output) {
        const { writeFileSync } = require("node:fs");
        writeFileSync(opts.output, result, "utf-8");
        console.log(chalk.green("✓ Exported " + type + " to " + opts.output));
      } else {
        console.log(result);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const configCmd = program.command("config").description("Manage configuration");
configCmd.command("set <key> <value>").description("Set a config value").action((key: string, value: string) => {
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = value; }
    setConfigValue(key, parsed);
    console.log(chalk.green(`✓ ${key} = ${JSON.stringify(parsed)}`));
  } catch (e) { handleError(e); }
});
configCmd.command("get <key>").description("Get a config value").action((key: string) => {
  try {
    const value = getConfigValue(key);
    if (value === undefined) { console.log(chalk.dim(`${key} is not set`)); }
    else { console.log(`${key} = ${JSON.stringify(value)}`); }
  } catch (e) { handleError(e); }
});
configCmd.command("list").description("List all config values").action(() => {
  try {
    const config = loadConfig();
    const keys = Object.keys(config);
    if (keys.length === 0) { console.log(chalk.dim("No config values set.")); return; }
    console.log(chalk.bold("\nConfig:"));
    for (const key of keys) { console.log(`  ${chalk.cyan(key)} = ${JSON.stringify(config[key])}`); }
    console.log();
  } catch (e) { handleError(e); }
});

// ─── LOG ─────────────────────────────────────────────────────────────────────
program.command("log").description("Show email send log")
  .option("--provider <id>", "Filter by provider ID")
  .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
  .option("--since <date>", "Show emails since date (ISO 8601)")
  .option("--limit <n>", "Max results", "20")
  .action((opts: { provider?: string; status?: string; since?: string; limit?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const limit = parseInt(opts.limit ?? "20", 10);
      const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, since: opts.since, limit });
      if (emails.length === 0) { output([], chalk.dim("No emails found.")); return; }
      const logLines: string[] = [];
      logLines.push(chalk.bold(`${"Date".padEnd(20)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  ${"Subject".padEnd(40)}  Status`));
      logLines.push(chalk.dim("\u2500".repeat(130)));
      for (const e of emails) {
        const date = new Date(e.sent_at).toLocaleString();
        const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
        const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
        const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
        let statusStr: string;
        switch (e.status) {
          case "delivered": statusStr = chalk.green(e.status); break;
          case "bounced": case "complained": case "failed": statusStr = chalk.red(e.status); break;
          default: statusStr = chalk.blue(e.status);
        }
        logLines.push(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj.padEnd(40)}  ${statusStr}`);
      }
      logLines.push("");
      output(emails, logLines.join("\n"));
    } catch (e) { handleError(e); }
  });

// ─── SEARCH ─────────────────────────────────────────────────────────────────
program.command("search <query>").description("Search emails by subject, from, or to")
  .option("--since <date>", "Show emails since date (ISO 8601)")
  .option("--limit <n>", "Max results", "20")
  .action((query: string, opts: { since?: string; limit?: string }) => {
    try {
      const limit = parseInt(opts.limit ?? "20", 10);
      const emails = searchEmails(query, { since: opts.since, limit });
      if (emails.length === 0) {
        const formatted = chalk.dim(`No emails matching "${query}".`);
        output([], formatted);
        return;
      }
      const lines: string[] = [];
      lines.push(chalk.bold(`${("Date").padEnd(20)}  ${("From").padEnd(30)}  ${("To").padEnd(30)}  ${("Subject").padEnd(40)}  Status`));
      lines.push(chalk.dim("\u2500".repeat(130)));
      for (const e of emails) {
        const date = new Date(e.sent_at).toLocaleString();
        const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
        const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
        const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
        let statusStr: string;
        switch (e.status) {
          case "delivered": statusStr = chalk.green(e.status); break;
          case "bounced": case "complained": case "failed": statusStr = chalk.red(e.status); break;
          default: statusStr = chalk.blue(e.status);
        }
        lines.push(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj.padEnd(40)}  ${statusStr}`);
      }
      lines.push("");
      output(emails, lines.join("\n"));
    } catch (e) { handleError(e); }
  });

// ─── SHOW EMAIL ──────────────────────────────────────────────────────────────
program.command("show <id>").description("Show full email details including body content")
  .action((id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "emails", id);
      if (!resolvedId) handleError(new Error(`Email not found: ${id}`));
      const emailRecord = getEmail(resolvedId!, db);
      if (!emailRecord) handleError(new Error(`Email not found: ${id}`));
      const content = getEmailContent(resolvedId!, db);

      console.log(chalk.bold(`\nEmail: ${emailRecord!.id}`));
      console.log(`  ${chalk.dim("Subject:")}  ${emailRecord!.subject}`);
      console.log(`  ${chalk.dim("From:")}     ${emailRecord!.from_address}`);
      console.log(`  ${chalk.dim("To:")}       ${emailRecord!.to_addresses.join(", ")}`);
      if (emailRecord!.cc_addresses.length > 0) console.log(`  ${chalk.dim("CC:")}       ${emailRecord!.cc_addresses.join(", ")}`);
      if (emailRecord!.bcc_addresses.length > 0) console.log(`  ${chalk.dim("BCC:")}      ${emailRecord!.bcc_addresses.join(", ")}`);
      if (emailRecord!.reply_to) console.log(`  ${chalk.dim("Reply-To:")} ${emailRecord!.reply_to}`);
      console.log(`  ${chalk.dim("Status:")}   ${colorStatus(emailRecord!.status)}`);
      console.log(`  ${chalk.dim("Sent:")}     ${emailRecord!.sent_at}`);
      if (emailRecord!.provider_message_id) console.log(`  ${chalk.dim("Msg ID:")}   ${emailRecord!.provider_message_id}`);

      if (content) {
        const headers = content.headers;
        if (Object.keys(headers).length > 0) {
          console.log(chalk.bold("\n  Headers:"));
          for (const [k, v] of Object.entries(headers)) {
            console.log(`    ${chalk.dim(k + ":")} ${v}`);
          }
        }

        if (content.text_body) {
          console.log(chalk.bold("\n  Body (text):"));
          console.log(content.text_body.split("\n").map((l: string) => `    ${l}`).join("\n"));
        } else if (content.html) {
          console.log(chalk.bold("\n  Body (HTML rendered as text):"));
          const textFromHtml = content.html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim();
          console.log(textFromHtml.split("\n").map((l: string) => `    ${l}`).join("\n"));
        }
      } else {
        console.log(chalk.dim("\n  No body content stored for this email."));
      }
      console.log();
    } catch (e) { handleError(e); }
  });

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
const webhookCmd = program.command("webhook").description("Webhook receiver for email events");
webhookCmd
  .command("listen")
  .description("Start webhook listener server")
  .option("--port <port>", "Port to listen on", "9877")
  .option("--provider <id>", "Provider ID to associate events with")
  .action(async (opts: { port?: string; provider?: string }) => {
    try {
      const { createWebhookServer } = await import("../lib/webhook.js");
      const port = parseInt(opts.port ?? "9877", 10);
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      createWebhookServer(port, providerId);
      console.log(chalk.bold(`Webhook listener started on port ${port}`));
      console.log(chalk.dim(`  POST /webhook/resend  — Resend webhook events`));
      console.log(chalk.dim(`  POST /webhook/ses     — SES SNS notifications`));
      console.log(chalk.dim(`  Press Ctrl+C to stop.\n`));
    } catch (e) { handleError(e); }
  });

// ─── DOMAIN CHECK ────────────────────────────────────────────────────────────
domainCmd
  .command("check <domain>")
  .description("Live DNS check — verify actual DNS records against expected")
  .option("--provider <id>", "Provider ID")
  .action(async (domain: string, opts: { provider?: string }) => {
    try {
      const { checkDnsRecords, formatDnsCheck } = await import("../lib/dns-check.js");

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
        const { generateSpfRecord, generateDmarcRecord } = await import("../lib/dns.js");
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

// ─── PREVIEW ─────────────────────────────────────────────────────────────────
program.command("preview <template-name>").description("Preview a template with sample variables")
  .option("--vars <json>", "Template variables as JSON string")
  .option("--open", "Open rendered HTML in browser")
  .action((templateName: string, opts: { vars?: string; open?: boolean }) => {
    try {
      const template = getTemplate(templateName);
      if (!template) handleError(new Error(`Template not found: ${templateName}`));
      const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};

      const renderedSubject = renderTemplate(template!.subject_template, vars);
      console.log(chalk.bold("\nSubject:"));
      console.log(`  ${renderedSubject}`);

      if (template!.html_template) {
        const renderedHtml = renderTemplate(template!.html_template, vars);
        console.log(chalk.bold("\nHTML Body:"));
        console.log(renderedHtml);

        if (opts.open) {
          const { writeFileSync } = require("node:fs");
          const tmpPath = `/tmp/emails-preview-${templateName}.html`;
          writeFileSync(tmpPath, renderedHtml, "utf-8");
          execSync(`open "${tmpPath}"`);
          console.log(chalk.dim(`\nOpened preview in browser: ${tmpPath}`));
        }
      }

      if (template!.text_template) {
        const renderedText = renderTemplate(template!.text_template, vars);
        console.log(chalk.bold("\nText Body:"));
        console.log(renderedText);
      }

      console.log();
    } catch (e) { handleError(e); }
  });

// ─── TEST ────────────────────────────────────────────────────────────────────
program.command("test [provider-id]").description("Send a test email")
  .option("--to <email>", "Recipient email address")
  .action(async (providerId?: string, opts?: { to?: string }) => {
    try {
      const db = getDatabase();
      let resolvedProviderId: string;
      if (providerId) { resolvedProviderId = resolveId("providers", providerId); }
      else {
        const defaultId = getDefaultProviderId();
        if (defaultId) {
          const resolved = resolvePartialId(db, "providers", defaultId);
          if (resolved) { resolvedProviderId = resolved; }
          else { handleError(new Error(`Default provider not found: ${defaultId}. Update with 'emails config set default_provider <id>'`)); }
        } else {
          const providers = listProviders(db).filter((p) => p.active);
          if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
          resolvedProviderId = providers[0]!.id;
        }
      }
      const provider = getProvider(resolvedProviderId!, db);
      if (!provider) handleError(new Error(`Provider not found: ${resolvedProviderId!}`));
      let toEmail = opts?.to;
      if (!toEmail) {
        const addrs = listAddresses(resolvedProviderId!, db);
        const v = addrs.find((a) => a.verified);
        if (v) { toEmail = v.email; } else if (addrs.length > 0) { toEmail = addrs[0]!.email; }
        else { handleError(new Error("No --to address specified and no addresses found for this provider")); }
      }
      const fromAddrs = listAddresses(resolvedProviderId!, db);
      let fromEmail: string;
      const vf = fromAddrs.find((a) => a.verified);
      if (vf) { fromEmail = vf.email; } else if (fromAddrs.length > 0) { fromEmail = fromAddrs[0]!.email; }
      else { handleError(new Error("No sender addresses configured for this provider. Add one with 'emails address add'")); }
      const ts = new Date().toISOString();
      const subject = `Test from open-emails \u2014 ${ts}`;
      const text = `This is a test email sent via open-emails at ${ts}. Provider: ${provider!.name} (${provider!.type})`;
      const adapter = getAdapter(provider!);
      const messageId = await adapter.sendEmail({ from: fromEmail!, to: toEmail!, subject, text });
      createEmail(resolvedProviderId!, { from: fromEmail!, to: toEmail!, subject, text }, messageId, db);
      console.log(chalk.green(`✓ Test email sent to ${toEmail}`));
      if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
      console.log(chalk.dim(`  From: ${fromEmail!}`));
      console.log(chalk.dim(`  Provider: ${provider!.name} (${provider!.type})`));
    } catch (e) { handleError(e); }
  });

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

program
  .command("analytics")
  .description("Show email analytics (daily volume, top recipients, busiest hours, delivery trend)")
  .option("--provider <id>", "Filter by provider ID")
  .option("--period <period>", "Time period (e.g. 30d, 7d, 90d)", "30d")
  .action((opts: { provider?: string; period: string }) => {
    try {
      let providerId = opts.provider;
      if (providerId) {
        providerId = resolveId("providers", providerId);
      }
      const data = getAnalytics(providerId, opts.period);
      output(data, formatAnalytics(data));
    } catch (e) {
      handleError(e);
    }
  });

// ─── COMPLETION ───────────────────────────────────────────────────────────────

program
  .command("completion")
  .description("Generate shell completion script")
  .argument("<shell>", "Shell type: bash, zsh, or fish")
  .action((shell: string) => {
    switch (shell) {
      case "bash":
        console.log(generateBashCompletion());
        break;
      case "zsh":
        console.log(generateZshCompletion());
        break;
      case "fish":
        console.log(generateFishCompletion());
        break;
      default:
        handleError(new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`));
    }
  });

// ─── DOCTOR ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Run system diagnostics")
  .action(async () => {
    try {
      const checks = await runDiagnostics();
      output(checks, formatDiagnostics(checks));
    } catch (e) {
      handleError(e);
    }
  });

// ─── SANDBOX ─────────────────────────────────────────────────────────────────

const sandboxCmd = program.command("sandbox").description("Inspect emails captured by sandbox providers");

sandboxCmd
  .command("list")
  .description("List captured sandbox emails")
  .option("--provider <id>", "Filter by provider ID")
  .option("--limit <n>", "Max results", "20")
  .action((opts: { provider?: string; limit?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const limit = parseInt(opts.limit ?? "20", 10);
      const emails = listSandboxEmails(providerId, limit);
      if (emails.length === 0) {
        output([], chalk.dim("No sandbox emails captured yet."));
        return;
      }
      const lines: string[] = [chalk.bold("\nSandbox Emails:")];
      lines.push(chalk.dim(`${"ID".padEnd(10)}  ${"Date".padEnd(22)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  Subject`));
      lines.push(chalk.dim("─".repeat(110)));
      for (const e of emails) {
        const date = new Date(e.created_at).toLocaleString();
        const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
        const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
        const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
        lines.push(`${chalk.cyan(e.id.slice(0, 8))}  ${date.padEnd(22)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj}`);
      }
      lines.push("");
      output(emails, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

sandboxCmd
  .command("show <id>")
  .description("Show full sandbox email details")
  .action((id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "sandbox_emails", id);
      if (!resolvedId) handleError(new Error(`Sandbox email not found: ${id}`));
      const email = getSandboxEmail(resolvedId!, db);
      if (!email) handleError(new Error(`Sandbox email not found: ${id}`));

      console.log(chalk.bold(`\nSandbox Email: ${email!.id}`));
      console.log(`  ${chalk.dim("Subject:")}  ${email!.subject}`);
      console.log(`  ${chalk.dim("From:")}     ${email!.from_address}`);
      console.log(`  ${chalk.dim("To:")}       ${email!.to_addresses.join(", ")}`);
      if (email!.cc_addresses.length > 0) console.log(`  ${chalk.dim("CC:")}       ${email!.cc_addresses.join(", ")}`);
      if (email!.bcc_addresses.length > 0) console.log(`  ${chalk.dim("BCC:")}      ${email!.bcc_addresses.join(", ")}`);
      if (email!.reply_to) console.log(`  ${chalk.dim("Reply-To:")} ${email!.reply_to}`);
      console.log(`  ${chalk.dim("Captured:")} ${email!.created_at}`);
      console.log(`  ${chalk.dim("Provider:")} ${email!.provider_id.slice(0, 8)}`);

      if (email!.text_body) {
        console.log(chalk.bold("\n  Body (text):"));
        console.log(email!.text_body.split("\n").map((l: string) => `    ${l}`).join("\n"));
      } else if (email!.html) {
        console.log(chalk.bold("\n  Body (HTML rendered as text):"));
        const textFromHtml = email!.html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        console.log(textFromHtml.split("\n").map((l: string) => `    ${l}`).join("\n"));
      }
      console.log();
    } catch (e) {
      handleError(e);
    }
  });

sandboxCmd
  .command("open <id>")
  .description("Open HTML content of a sandbox email in the browser")
  .action(async (id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "sandbox_emails", id);
      if (!resolvedId) handleError(new Error(`Sandbox email not found: ${id}`));
      const email = getSandboxEmail(resolvedId!, db);
      if (!email) handleError(new Error(`Sandbox email not found: ${id}`));
      if (!email!.html) handleError(new Error("This sandbox email has no HTML content."));

      const { writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: pathJoin } = await import("node:path");
      const tmpFile = pathJoin(tmpdir(), `sandbox-${resolvedId!.slice(0, 8)}.html`);
      writeFileSync(tmpFile, email!.html!);
      execSync(`open "${tmpFile}"`);
      console.log(chalk.green(`✓ Opened in browser: ${tmpFile}`));
    } catch (e) {
      handleError(e);
    }
  });

sandboxCmd
  .command("clear")
  .description("Delete all captured sandbox emails")
  .option("--provider <id>", "Only clear emails for a specific provider")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const db = getDatabase();
      const count = clearSandboxEmails(providerId, db);
      console.log(chalk.green(`✓ Cleared ${count} sandbox email(s)`));
    } catch (e) {
      handleError(e);
    }
  });

sandboxCmd
  .command("count")
  .description("Show count of captured sandbox emails")
  .option("--provider <id>", "Filter by provider ID")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const db = getDatabase();
      const count = getSandboxCount(providerId, db);
      output({ count }, `${count} sandbox email(s) captured`);
    } catch (e) {
      handleError(e);
    }
  });

// ─── INBOUND ──────────────────────────────────────────────────────────────────

const inboundCmd = program.command("inbound").description("Receive and inspect inbound emails");

inboundCmd
  .command("listen")
  .description("Start a local SMTP listener to receive inbound emails")
  .option("--port <port>", "SMTP port to listen on", "2525")
  .option("--provider <id>", "Associate received emails with this provider ID")
  .action((opts: { port?: string; provider?: string }) => {
    const port = parseInt(opts.port ?? "2525", 10);
    const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
    console.log(chalk.green(`✓ SMTP listener started on port ${port}`));
    if (providerId) console.log(chalk.dim(`  Provider: ${providerId}`));
    console.log(chalk.dim("  Press Ctrl+C to stop\n"));
    createSmtpServer(port, providerId);
    // Keep process alive
    process.stdin.resume();
  });

inboundCmd
  .command("list")
  .description("List received inbound emails")
  .option("--provider <id>", "Filter by provider ID")
  .option("--limit <n>", "Max results", "20")
  .action((opts: { provider?: string; limit?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const limit = parseInt(opts.limit ?? "20", 10);
      const emails = listInboundEmails({ provider_id: providerId, limit });
      if (emails.length === 0) {
        output([], chalk.dim("No inbound emails received yet."));
        return;
      }
      const lines: string[] = [chalk.bold("\nInbound Emails:")];
      for (const email of emails) {
        lines.push(
          `  ${chalk.cyan(email.id.slice(0, 8))}  ${chalk.dim(formatDate(email.received_at))}  ${truncate(email.from_address, 30)}  ${truncate(email.subject, 40)}`,
        );
      }
      output(emails, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

inboundCmd
  .command("show <id>")
  .description("Show full inbound email details")
  .action((id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "inbound_emails", id);
      if (!resolvedId) handleError(new Error(`Inbound email not found: ${id}`));
      const email = getInboundEmail(resolvedId!, db);
      if (!email) handleError(new Error(`Inbound email not found: ${id}`));
      const lines: string[] = [
        chalk.bold("\nInbound Email:"),
        `  ${chalk.dim("ID:")}       ${email!.id}`,
        `  ${chalk.dim("From:")}     ${email!.from_address}`,
        `  ${chalk.dim("To:")}       ${email!.to_addresses.join(", ")}`,
        `  ${chalk.dim("CC:")}       ${email!.cc_addresses.join(", ") || "(none)"}`,
        `  ${chalk.dim("Subject:")}  ${email!.subject}`,
        `  ${chalk.dim("Received:")} ${formatDate(email!.received_at)}`,
        `  ${chalk.dim("Size:")}     ${email!.raw_size} bytes`,
        "",
        chalk.bold("  Body (text):"),
        email!.text_body ? email!.text_body.slice(0, 500) : chalk.dim("  (none)"),
      ];
      if (email!.html_body) {
        lines.push("", chalk.bold("  Body (html):"), email!.html_body.slice(0, 200) + "...");
      }
      output(email, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  });

inboundCmd
  .command("open <id>")
  .description("Open HTML content of an inbound email in the browser")
  .action(async (id: string) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "inbound_emails", id);
      if (!resolvedId) handleError(new Error(`Inbound email not found: ${id}`));
      const email = getInboundEmail(resolvedId!, db);
      if (!email) handleError(new Error(`Inbound email not found: ${id}`));
      if (!email!.html_body) handleError(new Error("This inbound email has no HTML content."));

      const { writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: pathJoin } = await import("node:path");
      const tmpFile = pathJoin(tmpdir(), `inbound-${resolvedId!.slice(0, 8)}.html`);
      writeFileSync(tmpFile, email!.html_body!);
      execSync(`open "${tmpFile}"`);
      console.log(chalk.green(`✓ Opened in browser: ${tmpFile}`));
    } catch (e) {
      handleError(e);
    }
  });

inboundCmd
  .command("clear")
  .description("Delete all received inbound emails")
  .option("--provider <id>", "Only clear emails for a specific provider")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const db = getDatabase();
      const count = clearInboundEmails(providerId, db);
      console.log(chalk.green(`✓ Cleared ${count} inbound email(s)`));
    } catch (e) {
      handleError(e);
    }
  });

inboundCmd
  .command("count")
  .description("Show count of received inbound emails")
  .option("--provider <id>", "Filter by provider ID")
  .action((opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const db = getDatabase();
      const count = getInboundCount(providerId, db);
      output({ count }, `${count} inbound email(s) received`);
    } catch (e) {
      handleError(e);
    }
  });

program.parse(process.argv);
