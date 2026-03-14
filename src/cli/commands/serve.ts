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
    .action(async (opts: { port?: string }) => {
      const { startServer } = await import("../../server/serve.js");
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
}
