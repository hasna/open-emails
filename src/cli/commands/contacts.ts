import type { Command } from "commander";
import chalk from "chalk";
import { listContacts, suppressContact, unsuppressContact } from "../../db/contacts.js";
import { handleError } from "../utils.js";

export function registerContactCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
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
}
