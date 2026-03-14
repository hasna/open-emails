import type { Command } from "commander";
import chalk from "chalk";
import { listEmails } from "../../db/emails.js";
import { getLocalStats, formatStatsTable } from "../../lib/stats.js";
import { syncAll, syncProvider } from "../../lib/sync.js";
import { getAnalytics, formatAnalytics } from "../../lib/analytics.js";
import { colorStatus, truncate } from "../../lib/format.js";
import { handleError, resolveId, parseDuration, padRight } from "../utils.js";

export function registerSyncCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── PULL ─────────────────────────────────────────────────────────────────────
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
}
