import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { handleError } from "../utils.js";

export function registerServeCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  // ─── SERVE ────────────────────────────────────────────────────────────────────
  program
    .command("serve")
    .description("Start the HTTP server and dashboard")
    .option("--port <port>", "Port to listen on", "3900")
    .option("--host <host>", "Host to bind to (default: 127.0.0.1, use 0.0.0.0 for all interfaces)", "127.0.0.1")
    .option("--webhook-port <port>", "Also start webhook listener on this port")
    .option("--smtp-port <port>", "Also start SMTP inbound listener on this port")
    .option("--all", "Start all listeners (HTTP :3900, webhook :9877, SMTP :2525)")
    .option("--provider <id>", "Provider ID for inbound/webhook listeners")
    .action(async (opts: { port?: string; host?: string; webhookPort?: string; smtpPort?: string; all?: boolean; provider?: string }) => {
      const { startServer } = await import("../../server/serve.js");
      const port = parseInt(opts.port ?? "3900", 10);
      const host = opts.host ?? "127.0.0.1";
      await startServer(port, host);

      const webhookPort = opts.all ? 9877 : (opts.webhookPort ? parseInt(opts.webhookPort, 10) : null);
      const smtpPort = opts.all ? 2525 : (opts.smtpPort ? parseInt(opts.smtpPort, 10) : null);
      if (webhookPort) {
        const { createWebhookServer } = await import("../../lib/webhook.js");
        createWebhookServer(webhookPort, opts.provider);
        console.log(chalk.dim(`  Webhook listener on port ${webhookPort}`));
      }
      if (smtpPort) {
        const { createSmtpServer } = await import("../../lib/inbound.js");
        createSmtpServer(smtpPort, opts.provider);
        console.log(chalk.dim(`  SMTP listener on port ${smtpPort}`));
      }
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
}
