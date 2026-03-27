import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, getConfigValue, setConfigValue } from "../../lib/config.js";
import { handleError } from "../utils.js";

const KNOWN_KEYS: { key: string; description: string; example: string }[] = [
  { key: "default_provider", description: "Default provider ID used when --provider is not specified", example: "abc12345" },
  { key: "failover-providers", description: "Comma-separated provider IDs used as failover for send()", example: "abc12345,def67890" },
  { key: "gmail_attachment_storage", description: "Where to store Gmail attachments: local | s3 | none", example: "local" },
  { key: "gmail_s3_bucket", description: "S3 bucket name for attachment storage (requires gmail_attachment_storage=s3)", example: "my-email-archive" },
  { key: "gmail_s3_prefix", description: "S3 key prefix for attachments (default: emails)", example: "emails" },
  { key: "gmail_s3_region", description: "AWS region for S3 uploads (default: us-east-1)", example: "us-east-1" },
  { key: "cloudflare_api_token", description: "Cloudflare API token for auto DNS setup (also reads CLOUDFLARE_API_TOKEN env var)", example: "abc123..." },
];

export function registerConfigCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const configCmd = program.command("config").description("Manage configuration");

  configCmd
    .command("set <key> <value>")
    .description("Set a config value")
    .action((key: string, value: string) => {
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        setConfigValue(key, parsed);
        console.log(chalk.green(`✓ ${key} = ${JSON.stringify(parsed)}`));
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("get <key>")
    .description("Get a config value")
    .action((key: string) => {
      try {
        const value = getConfigValue(key);
        if (value === undefined) { console.log(chalk.dim(`${key} is not set`)); }
        else { console.log(`${key} = ${JSON.stringify(value)}`); }
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("unset <key>")
    .description("Remove a config value")
    .action((key: string) => {
      try {
        const config = loadConfig();
        if (!(key in config)) {
          console.log(chalk.dim(`${key} is not set`));
          return;
        }
        delete config[key];
        saveConfig(config);
        console.log(chalk.green(`✓ ${key} removed`));
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("list")
    .description("List all config values")
    .action(() => {
      try {
        const config = loadConfig();
        const keys = Object.keys(config);
        if (keys.length === 0) { output({}, chalk.dim("No config values set. Run 'emails config keys' to see available keys.")); return; }
        console.log(chalk.bold("\nConfig:"));
        for (const key of keys) { console.log(`  ${chalk.cyan(key.padEnd(32))} ${JSON.stringify(config[key])}`); }
        console.log();
        output(config, "");
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("keys")
    .description("Show all known config keys with descriptions")
    .action(() => {
      console.log(chalk.bold("\nKnown config keys:\n"));
      for (const k of KNOWN_KEYS) {
        console.log(`  ${chalk.cyan(k.key)}`);
        console.log(`    ${chalk.dim(k.description)}`);
        console.log(`    ${chalk.dim("e.g.")} ${k.example}\n`);
      }
      console.log(chalk.dim("Set with: emails config set <key> <value>"));
      console.log();
    });
}
