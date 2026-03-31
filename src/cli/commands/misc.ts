import type { Command } from "commander";
import chalk from "chalk";
import { listScheduledEmails, cancelScheduledEmail, getDueEmails, markSent, markFailed } from "../../db/scheduled.js";
import { getProvider } from "../../db/providers.js";
import { createEmail } from "../../db/emails.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { listProviders } from "../../db/providers.js";
import { getAdapter } from "../../providers/index.js";
import { batchSend } from "../../lib/batch.js";
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from "../../lib/completion.js";
import { runDiagnostics, formatDiagnostics } from "../../lib/doctor.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import {
  getDueEnrollments, advanceEnrollment, listSteps,
} from "../../db/sequences.js";
import { handleError, resolveId, parseDuration } from "../utils.js";

export function registerMiscCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── SCHEDULE ───────────────────────────────────────────────────────────────
  // Unified `schedule` command. Old `scheduled` kept as alias.
  const scheduleCmd = program.command("schedule").description("Manage and run the email scheduler");
  // Keep `scheduled` as alias
  const scheduledCmd = program.command("scheduled").description("Manage scheduled emails (alias: emails schedule)");

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

  // schedule list / cancel — same as scheduled but under unified command
  scheduleCmd
    .command("list")
    .description("List scheduled emails")
    .option("--status <status>", "Filter: pending|sent|cancelled|failed")
    .action((opts: { status?: string }) => {
      try {
        const status = opts.status as "pending" | "sent" | "cancelled" | "failed" | undefined;
        const emails = listScheduledEmails(status ? { status } : undefined);
        if (emails.length === 0) { console.log(chalk.dim("No scheduled emails.")); return; }
        console.log(chalk.bold("\nScheduled:"));
        for (const e of emails) {
          const sc = e.status === "pending" ? chalk.blue(e.status) : e.status === "sent" ? chalk.green(e.status) : e.status === "cancelled" ? chalk.yellow(e.status) : chalk.red(e.status);
          console.log(`  ${chalk.cyan(e.id.slice(0,8))}  ${e.scheduled_at}  [${sc}]  ${e.subject}  → ${e.to_addresses.join(", ")}`);
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  scheduleCmd
    .command("cancel <id>")
    .description("Cancel a scheduled email")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "scheduled_emails", id);
        if (!resolvedId) handleError(new Error(`Scheduled email not found: ${id}`));
        if (!cancelScheduledEmail(resolvedId!, db)) handleError(new Error(`Cannot cancel ${id}`));
        console.log(chalk.green(`✓ Cancelled: ${resolvedId!.slice(0,8)}`));
      } catch (e) { handleError(e); }
    });

  scheduleCmd
    .command("run")
    .description("Start the scheduler daemon — sends due emails on interval")
    .option("--interval <duration>", "Poll interval (e.g. 30s, 1m)", "30s")
    .action(async (opts: { interval?: string }) => {
      try {
        const interval = parseDuration(opts.interval || "30s");
        console.log(chalk.blue(`Scheduler running. Polling every ${opts.interval || "30s"}. Press Ctrl+C to stop.`));
        while (true) {
          const due = getDueEmails();
          for (const scheduled of due) {
            try {
              const provider = getProvider(scheduled.provider_id);
              if (!provider) { markFailed(scheduled.id, "Provider not found"); continue; }
              const adapter = getAdapter(provider);
              const sendOpts = {
                from: scheduled.from_address, to: scheduled.to_addresses,
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
              console.log(chalk.green(`✓ Sent ${scheduled.id.slice(0,8)} to ${scheduled.to_addresses.join(", ")}`));
            } catch (err) {
              markFailed(scheduled.id, err instanceof Error ? err.message : String(err));
              console.log(chalk.red(`✗ Failed ${scheduled.id.slice(0,8)}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          await new Promise(r => setTimeout(r, interval));
        }
      } catch (e) { handleError(e); }
    });

  // ─── SCHEDULER (alias) ───────────────────────────────────────────────────────
  program
    .command("scheduler")
    .description("Start the email scheduler (alias: emails schedule run)")
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

          // Process due sequence enrollments
          const dueEnrollments = getDueEnrollments();
          for (const enrollment of dueEnrollments) {
            try {
              const steps = listSteps(enrollment.sequence_id);
              const stepIndex = enrollment.current_step; // 0-based index into sorted steps array
              const step = steps[stepIndex];
              if (!step) {
                // No step at this index — advance/complete
                advanceEnrollment(enrollment.id);
                continue;
              }

              const template = getTemplate(step.template_name);
              if (!template) {
                console.log(chalk.yellow(`⚠ Template not found for sequence step: ${step.template_name}`));
                advanceEnrollment(enrollment.id);
                continue;
              }

              const vars: Record<string, string> = { email: enrollment.contact_email };
              const subject = renderTemplate(
                step.subject_override || template.subject_template,
                vars,
              );
              const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
              const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;

              // Resolve provider: enrollment's provider or first active provider
              const db = getDatabase();
              const providerRow = enrollment.provider_id
                ? (db.query("SELECT * FROM providers WHERE id = ?").get(enrollment.provider_id) as { id: string; active: number } | null)
                : (db.query("SELECT * FROM providers WHERE active = 1 LIMIT 1").get() as { id: string; active: number } | null);

              if (!providerRow) {
                console.log(chalk.yellow(`⚠ No provider for sequence enrollment ${enrollment.id.slice(0, 8)}`));
                continue;
              }

              const seqProvider = getProvider(providerRow.id);
              if (!seqProvider) {
                console.log(chalk.yellow(`⚠ Provider not found for sequence enrollment ${enrollment.id.slice(0, 8)}`));
                continue;
              }

              const adapter = getAdapter(seqProvider);
              const sendOpts = {
                from: step.from_address || "",
                to: [enrollment.contact_email],
                subject,
                html,
                text,
              };

              if (!sendOpts.from) {
                // Try to get from address from provider's first address
                const addrRow = db.query("SELECT email FROM addresses WHERE provider_id = ? LIMIT 1").get(seqProvider.id) as { email: string } | null;
                if (addrRow) sendOpts.from = addrRow.email;
              }

              if (!sendOpts.from) {
                console.log(chalk.yellow(`⚠ No from address for sequence step ${step.id.slice(0, 8)}`));
                advanceEnrollment(enrollment.id);
                continue;
              }

              const messageId = await adapter.sendEmail(sendOpts);
              createEmail(seqProvider.id, sendOpts, messageId);
              advanceEnrollment(enrollment.id);
              console.log(chalk.green(`✓ Sent sequence step ${step.step_number} to ${enrollment.contact_email}`));
            } catch (err) {
              console.log(chalk.red(`✗ Failed sequence enrollment ${enrollment.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }

          await new Promise(r => setTimeout(r, interval));
        }
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

  // ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
  program
    .command("verify-email <email>")
    .description("Verify an email address (format + MX records + optional SMTP probe)")
    .option("--smtp", "Also do SMTP probe (RCPT TO check, no email sent)")
    .option("--timeout <ms>", "DNS/SMTP timeout in milliseconds", "5000")
    .action(async (email: string, opts: { smtp?: boolean; timeout?: string }) => {
      try {
        const { verifyEmailAddress, formatVerifyResult } = await import("../../lib/email-verify.js");
        const result = await verifyEmailAddress(email, {
          smtpProbe: !!opts.smtp,
          timeoutMs: parseInt(opts.timeout ?? "5000", 10),
        });
        const formatted = formatVerifyResult(result);
        output(result, result.valid ? chalk.green(formatted) : chalk.red(formatted));
      } catch (e) {
        handleError(e);
      }
    });
}
