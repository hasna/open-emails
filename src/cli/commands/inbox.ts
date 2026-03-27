import type { Command } from "commander";
import chalk from "chalk";
import { syncGmailInbox, syncGmailInboxAll, listGmailLabels } from "../../lib/gmail-sync.js";
import { listInboundEmails, getInboundEmail, deleteInboundEmail, clearInboundEmails, getInboundCount } from "../../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../../db/gmail-sync-state.js";
import { listProviders } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { handleError } from "../utils.js";

export function registerInboxCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const inboxCmd = program.command("inbox").description("Sync and browse Gmail inboxes");

  // ─── SYNC ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("sync")
    .description("Sync Gmail inbox messages into local SQLite")
    .option("--provider <id>", "Provider ID or name (defaults to first active Gmail provider)")
    .option("--label <label>", "Gmail label to sync (e.g. INBOX, SENT, label ID)", "INBOX")
    .option("--query <query>", "Gmail search query (e.g. 'is:unread from:boss@example.com')")
    .option("--limit <n>", "Max messages per sync run", "50")
    .option("--since <date>", "Only sync messages after this date (ISO 8601 or YYYY-MM-DD)")
    .option("--all", "Sync all pages until done (use for initial backfill)")
    .action(async (opts: {
      provider?: string;
      label?: string;
      query?: string;
      limit?: string;
      since?: string;
      all?: boolean;
    }) => {
      try {
        const db = getDatabase();

        // Resolve provider
        const providerId = resolveGmailProvider(opts.provider);
        if (!providerId) {
          console.error(chalk.red("No Gmail provider found. Add one with: emails provider add-gmail"));
          process.exit(1);
        }

        const syncOpts = {
          providerId,
          labelFilter: opts.label,
          query: opts.query,
          batchSize: parseInt(opts.limit ?? "50", 10),
          since: opts.since,
          db,
        };

        console.log(chalk.dim(`Syncing Gmail inbox for provider ${providerId}...`));

        const result = opts.all
          ? await syncGmailInboxAll(syncOpts)
          : await syncGmailInbox(syncOpts);

        // Update sync state
        updateLastSynced(providerId, undefined, db);

        output(result, formatSyncResult(result, opts.all));

        if (result.errors.length > 0) {
          console.log(chalk.yellow("\nErrors:"));
          for (const e of result.errors) console.log(chalk.yellow(`  ${e}`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LIST ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("list")
    .description("List synced inbound emails from local SQLite")
    .option("--provider <id>", "Filter by provider ID")
    .option("--since <date>", "Only show emails after this date")
    .option("--limit <n>", "Max results", "20")
    .option("--search <query>", "Filter by subject/from (local, not Gmail API)")
    .action((opts: { provider?: string; since?: string; limit?: string; search?: string }) => {
      try {
        const db = getDatabase();
        const limit = parseInt(opts.limit ?? "20", 10);
        let emails = listInboundEmails({ provider_id: opts.provider, since: opts.since, limit }, db);

        if (opts.search) {
          const q = opts.search.toLowerCase();
          emails = emails.filter(
            (e) => e.subject.toLowerCase().includes(q) || e.from_address.toLowerCase().includes(q),
          );
        }

        if (emails.length === 0) {
          console.log(chalk.dim("No emails found. Run `emails inbox sync` to pull from Gmail."));
          return;
        }

        output(emails, formatEmailList(emails));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── SEARCH ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("search <query>")
    .description("Search synced emails locally (add --remote to search live Gmail)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Max results", "20")
    .option("--remote", "Search live Gmail via connector (not just local DB)")
    .action(async (query: string, opts: { provider?: string; limit?: string; remote?: boolean }) => {
      try {
        const db = getDatabase();
        const limit = parseInt(opts.limit ?? "20", 10);

        if (opts.remote) {
          // Live Gmail search via SDK
          const { Gmail } = await import("@hasna/connect-gmail");
          const { getProvider } = await import("../../db/providers.js");
          const providerId = resolveGmailProvider(opts.provider);
          if (!providerId) {
            console.error(chalk.red("No Gmail provider found."));
            process.exit(1);
          }
          const provider = getProvider(providerId, db);
          if (!provider) {
            console.error(chalk.red(`Provider not found: ${providerId}`));
            process.exit(1);
          }
          const gmail = Gmail.createWithTokens({
            accessToken: provider.oauth_access_token ?? "",
            refreshToken: provider.oauth_refresh_token ?? "",
            clientId: provider.oauth_client_id ?? "",
            clientSecret: provider.oauth_client_secret ?? "",
            expiresAt: provider.oauth_token_expiry ? new Date(provider.oauth_token_expiry).getTime() : undefined,
          });
          const listRes = await gmail.messages.list({ q: query, maxResults: parseInt(opts.limit ?? "20", 10) });
          const results = (listRes.messages ?? []).map((m) => ({ id: m.id ?? "", from: "", subject: "", date: "" }));
          output(results, formatRemoteResults(results, query));
          return;
        }

        // Local DB search
        const q = query.toLowerCase();
        const emails = listInboundEmails({ provider_id: opts.provider, limit: limit * 4 }, db).filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.from_address.toLowerCase().includes(q) ||
            (e.text_body ?? "").toLowerCase().includes(q),
        ).slice(0, limit);

        if (emails.length === 0) {
          console.log(chalk.dim(`No results for "${query}". Try --remote to search live Gmail.`));
          return;
        }

        output(emails, formatEmailList(emails, `Search: "${query}"`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── STATUS ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("status")
    .description("Show sync status per Gmail provider")
    .action(() => {
      try {
        const db = getDatabase();
        const providers = listProviders(db).filter((p) => p.type === "gmail");

        if (providers.length === 0) {
          console.log(chalk.dim("No Gmail providers configured. Add one with: emails provider add-gmail"));
          return;
        }

        console.log(chalk.bold("\nGmail Sync Status:"));
        for (const p of providers) {
          const state = getGmailSyncState(p.id, db);
          const count = getInboundCount(p.id, db);
          console.log(`\n  ${chalk.cyan(p.name)} ${chalk.dim(`[${p.id.slice(0, 8)}]`)}`);
          console.log(`    Synced emails:  ${count}`);
          console.log(`    Last synced:    ${state?.last_synced_at ? chalk.green(state.last_synced_at) : chalk.dim("never")}`);
          if (state?.last_message_id) console.log(`    Last message:   ${state.last_message_id}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LABELS ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("labels")
    .description("List available Gmail labels for the connected account")
    .option("--provider <id>", "Provider ID (defaults to first active Gmail provider)")
    .action(async (opts: { provider?: string }) => {
      try {
        const providerId = resolveGmailProvider(opts.provider);
        if (!providerId) {
          console.error(chalk.red("No Gmail provider found. Add one with: emails provider add-gmail"));
          process.exit(1);
        }
        const labels = await listGmailLabels(providerId);
        if (labels.length === 0) {
          console.log(chalk.dim("No labels found. Is this Gmail provider authenticated?"));
          return;
        }
        console.log(chalk.bold("\nGmail Labels:"));
        for (const l of labels) {
          console.log(`  ${chalk.cyan(l.id.padEnd(28))} ${l.name}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  // ─── READ ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("read <id>")
    .description("Read a synced email from local DB")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const email = getInboundEmail(id, db);
        if (!email) {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
        output(email, formatEmailDetail(email));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DELETE ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("delete <id>")
    .description("Delete a synced email from local DB (does not affect Gmail)")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const deleted = deleteInboundEmail(id, db);
        if (deleted) {
          console.log(chalk.green(`✓ Deleted email ${id.slice(0, 8)}`));
        } else {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── CLEAR ────────────────────────────────────────────────────────────────
  inboxCmd
    .command("clear")
    .description("Clear all synced emails from local DB (does not affect Gmail)")
    .option("--provider <id>", "Only clear emails for this provider")
    .action((opts: { provider?: string }) => {
      try {
        const db = getDatabase();
        const deleted = clearInboundEmails(opts.provider, db);
        console.log(chalk.green(`✓ Cleared ${deleted} email(s)`));
      } catch (e) {
        handleError(e);
      }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveGmailProvider(idOrName?: string): string | null {
  const db = getDatabase();
  const providers = listProviders(db).filter((p) => p.type === "gmail" && p.active);

  if (!idOrName) return providers[0]?.id ?? null;

  const match = providers.find(
    (p) => p.id === idOrName || p.id.startsWith(idOrName) || p.name === idOrName,
  );
  return match?.id ?? null;
}

function formatSyncResult(
  result: { synced: number; skipped: number; errors: string[]; done: boolean },
  all?: boolean,
): string {
  const lines: string[] = [chalk.bold("\nSync complete:")];
  lines.push(`  Synced:  ${chalk.green(String(result.synced))}`);
  lines.push(`  Skipped: ${result.skipped > 0 ? chalk.dim(String(result.skipped)) : "0"} (already in DB)`);
  if (result.errors.length > 0) lines.push(`  Errors:  ${chalk.red(String(result.errors.length))}`);
  if (!result.done && !all) lines.push(chalk.dim("  More pages available. Use --all to sync everything."));
  lines.push("");
  return lines.join("\n");
}

function formatEmailList(
  emails: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null }[],
  title = "Inbound Emails",
): string {
  const lines: string[] = [chalk.bold(`\n${title} (${emails.length}):`)];
  for (const e of emails) {
    const date = new Date(e.received_at).toLocaleDateString();
    lines.push(
      `  ${chalk.dim(e.id.slice(0, 8))}  ${chalk.cyan(e.from_address.slice(0, 28).padEnd(28))}  ${e.subject.slice(0, 50).padEnd(50)}  ${chalk.dim(date)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatRemoteResults(
  results: { id: string; from: string; subject: string; date: string }[],
  query: string,
): string {
  const lines: string[] = [chalk.bold(`\nGmail search: "${query}" (${results.length} results):`)];
  for (const r of results) {
    lines.push(
      `  ${chalk.dim(r.id.slice(0, 16))}  ${chalk.cyan(r.from.slice(0, 28).padEnd(28))}  ${r.subject.slice(0, 50)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatEmailDetail(
  email: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; to_addresses: string[]; cc_addresses: string[] },
): string {
  const lines: string[] = [
    chalk.bold(`\n  Subject: ${email.subject}`),
    `  From:    ${chalk.cyan(email.from_address)}`,
    `  To:      ${email.to_addresses.join(", ")}`,
    email.cc_addresses.length > 0 ? `  CC:      ${email.cc_addresses.join(", ")}` : "",
    `  Date:    ${email.received_at}`,
    `  ID:      ${chalk.dim(email.id)}`,
    "",
    email.text_body ?? chalk.dim("(no body)"),
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
