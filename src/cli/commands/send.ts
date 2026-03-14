import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { createEmail, listEmails, getEmail, searchEmails } from "../../db/emails.js";
import { getEmailContent, storeEmailContent } from "../../db/email-content.js";
import { listProviders, getProvider } from "../../db/providers.js";
import { listAddresses } from "../../db/addresses.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { isContactSuppressed, incrementSendCount } from "../../db/contacts.js";
import { createScheduledEmail } from "../../db/scheduled.js";
import { getGroupByName, listMembers } from "../../db/groups.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { getDefaultProviderId } from "../../lib/config.js";
import { sendWithFailover } from "../../lib/send.js";
import { colorStatus } from "../../lib/format.js";
import { log } from "../../lib/logger.js";
import { handleError, resolveId } from "../utils.js";

export function registerSendCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
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
    .option("--track-opens", "Inject tracking pixel to detect email opens (requires emails serve running)")
    .option("--track-clicks", "Rewrite links to track clicks (requires emails serve running)")
    .option("--tracking-url <url>", "Base URL for tracking server (default: http://localhost:3900)")
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
      trackOpens?: boolean;
      trackClicks?: boolean;
      trackingUrl?: string;
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

        // Check domain warming limits
        const fromDomain = opts.from?.split("@")[1];
        if (fromDomain) {
          const { getWarmingSchedule } = await import("../../db/warming.js");
          const { getTodayLimit, getTodaySentCount } = await import("../../lib/warming.js");
          const warmingSchedule = getWarmingSchedule(fromDomain, db);
          if (warmingSchedule) {
            const limit = getTodayLimit(warmingSchedule);
            if (limit !== null) {
              const sent = getTodaySentCount(fromDomain, db);
              if (sent >= limit) {
                const enforceWarming = !!(opts as Record<string, unknown>).force;
                const msg = `Warming limit reached for ${fromDomain}: ${sent}/${limit} emails sent today.`;
                if (enforceWarming) {
                  log.warn(chalk.yellow(`⚠ ${msg} (--force bypasses warming)`));
                } else {
                  handleError(new Error(`${msg} Use --force to bypass or wait until tomorrow.`));
                }
              } else if (sent >= limit * 0.8) {
                log.warn(chalk.yellow(`⚠ Warming: ${sent}/${limit} emails sent today from ${fromDomain} (${Math.round(sent/limit*100)}%)`));
              }
            }
          }
        }

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

        // Store email content (with tracking injected if requested)
        let storedHtml = htmlBody;
        if ((opts.trackOpens || opts.trackClicks) && htmlBody) {
          const { prepareTrackedHtml } = await import("../../lib/tracking.js");
          // If --tracking-url was specified, temporarily use it by setting the config key
          if (opts.trackingUrl) {
            const { setConfigValue } = await import("../../lib/config.js");
            setConfigValue("tracking-base-url", opts.trackingUrl);
          }
          storedHtml = await prepareTrackedHtml(htmlBody, email.id, !!opts.trackOpens, !!opts.trackClicks);
          log.info(chalk.dim("  Tracking enabled — open emails serve to record opens/clicks"));
        }
        storeEmailContent(email.id, { html: storedHtml, text: textBody }, db);

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
        const { getAdapter } = await import("../../providers/index.js");
        const adapter = getAdapter(provider!);
        const messageId = await adapter.sendEmail({ from: fromEmail!, to: toEmail!, subject, text });
        createEmail(resolvedProviderId!, { from: fromEmail!, to: toEmail!, subject, text }, messageId, db);
        console.log(chalk.green(`✓ Test email sent to ${toEmail}`));
        if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
        console.log(chalk.dim(`  From: ${fromEmail!}`));
        console.log(chalk.dim(`  Provider: ${provider!.name} (${provider!.type})`));
      } catch (e) { handleError(e); }
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

        const { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } = require("../../lib/export.js");
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

  // ─── WEBHOOK ─────────────────────────────────────────────────────────────────
  const webhookCmd = program.command("webhook").description("Webhook receiver for email events");
  webhookCmd
    .command("listen")
    .description("Start webhook listener server")
    .option("--port <port>", "Port to listen on", "9877")
    .option("--provider <id>", "Provider ID to associate events with")
    .action(async (opts: { port?: string; provider?: string }) => {
      try {
        const { createWebhookServer } = await import("../../lib/webhook.js");
        const port = parseInt(opts.port ?? "9877", 10);
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        createWebhookServer(port, providerId);
        console.log(chalk.bold(`Webhook listener started on port ${port}`));
        console.log(chalk.dim(`  POST /webhook/resend  — Resend webhook events`));
        console.log(chalk.dim(`  POST /webhook/ses     — SES SNS notifications`));
        console.log(chalk.dim(`  Press Ctrl+C to stop.\n`));
      } catch (e) { handleError(e); }
    });
}
