import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getConfigValue, setConfigValue } from "../../lib/config.js";
import { handleError } from "../utils.js";

export function registerConfigCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
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
}
