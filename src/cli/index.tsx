#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../lib/logger.js";

import { registerProviderCommands } from "./commands/provider.js";
import { registerDomainCommands } from "./commands/domain.js";
import { registerAddressCommands } from "./commands/address.js";
import { registerSendCommands } from "./commands/send.js";
import { registerSyncCommands } from "./commands/sync.js";
import { registerServeCommands } from "./commands/serve.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerTemplateCommands } from "./commands/templates.js";
import { registerContactCommands } from "./commands/contacts.js";
import { registerGroupCommands } from "./commands/groups.js";
import { registerSequenceCommands } from "./commands/sequences.js";
import { registerSandboxCommands } from "./commands/sandbox.js";
import { registerInboundCommands } from "./commands/inbound.js";
import { registerMiscCommands } from "./commands/misc.js";
import { registerInboxCommands } from "./commands/inbox.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

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

registerProviderCommands(program, output);
registerDomainCommands(program, output);
registerAddressCommands(program, output);
registerSendCommands(program, output);
registerSyncCommands(program, output);
registerServeCommands(program, output);
registerConfigCommands(program, output);
registerTemplateCommands(program, output);
registerContactCommands(program, output);
registerGroupCommands(program, output);
registerSequenceCommands(program, output);
registerSandboxCommands(program, output);
registerInboundCommands(program, output);
registerMiscCommands(program, output);
registerInboxCommands(program, output);

program.parse(process.argv);
