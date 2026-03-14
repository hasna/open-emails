import type { Command } from "commander";
import chalk from "chalk";
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMembers, getMemberCount } from "../../db/groups.js";
import { handleError } from "../utils.js";

export function registerGroupCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  const groupCmd = program.command("group").description("Manage recipient groups");

  groupCmd
    .command("create <name>")
    .description("Create a recipient group")
    .option("--description <text>", "Group description")
    .action((name: string, opts: { description?: string }) => {
      try {
        const group = createGroup(name, opts.description);
        console.log(chalk.green(`✓ Group created: ${group.name} (${group.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("list")
    .description("List recipient groups")
    .action(() => {
      try {
        const groups = listGroups();
        if (groups.length === 0) {
          console.log(chalk.dim("No groups configured. Use 'emails group create' to add one."));
          return;
        }
        console.log(chalk.bold("\nGroups:"));
        for (const g of groups) {
          const count = getMemberCount(g.id);
          const desc = g.description ? chalk.dim(` — ${g.description}`) : "";
          console.log(`  ${chalk.cyan(g.id.slice(0, 8))}  ${g.name}  (${count} members)${desc}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("show <name>")
    .description("Show group details and members")
    .action((name: string) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        const members = listMembers(group!.id);
        console.log(chalk.bold(`
Group: ${group!.name}`));
        if (group!.description) console.log(chalk.dim(`  ${group!.description}`));
        console.log(`  Members (${members.length}):`);
        if (members.length === 0) {
          console.log(chalk.dim("    No members. Use 'emails group add' to add some."));
        } else {
          for (const m of members) {
            const displayName = m.name ? ` (${m.name})` : "";
            const vars = Object.keys(m.vars).length > 0 ? chalk.dim(` vars=${JSON.stringify(m.vars)}`) : "";
            console.log(`    ${m.email}${displayName}${vars}`);
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("add <name> <emails...>")
    .description("Add members to a group")
    .option("--name <displayName>", "Display name for the member(s)")
    .action((name: string, emails: string[], opts: { name?: string }) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        for (const email of emails) {
          addMember(group!.id, email, opts.name);
        }
        console.log(chalk.green(`✓ Added ${emails.length} member(s) to group '${name}'`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("remove-member <name> <email>")
    .description("Remove a member from a group")
    .action((name: string, email: string) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        const removed = removeMember(group!.id, email);
        if (!removed) handleError(new Error(`Member not found: ${email}`));
        console.log(chalk.green(`✓ Removed ${email} from group '${name}'`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("delete <name>")
    .description("Delete a group")
    .action((name: string) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        deleteGroup(group!.id);
        console.log(chalk.green(`✓ Group deleted: ${name}`));
      } catch (e) {
        handleError(e);
      }
    });
}
