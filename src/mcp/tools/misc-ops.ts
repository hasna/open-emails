// MCP tool module: misc-ops.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMembers, getMemberCount } from '../../db/groups.js';
import { listSandboxEmails, getSandboxEmail, clearSandboxEmails } from '../../db/sandbox.js';
import { getDatabase, resolvePartialId } from '../../db/database.js';
import { sendWithFailover } from '../../lib/send.js';
import { formatError, resolveId, ProviderNotFoundError } from '../helpers.js';

export function registerMiscOpsTools(server: McpServer): void {
  // ─── GROUPS ─────────────────────────────────────────────────────────────────

  server.tool(
  "list_groups",
  "List all recipient groups",
  {},
  async () => {
    try {
      const groups = listGroups();
      const result = groups.map(g => ({
        ...g,
        member_count: getMemberCount(g.id),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "create_group",
  "Create a new recipient group",
  {
    name: z.string().describe("Unique group name"),
    description: z.string().optional().describe("Group description"),
  },
  async ({ name, description }) => {
    try {
      const group = createGroup(name, description);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "delete_group",
  "Delete a recipient group",
  {
    name: z.string().describe("Group name"),
  },
  async ({ name }) => {
    try {
      const group = getGroupByName(name);
      if (!group) throw new Error(`Group not found: ${name}`);
      deleteGroup(group.id);
      return { content: [{ type: "text", text: `Group deleted: ${name}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_group_member",
  "Add a member to a recipient group",
  {
    group_name: z.string().describe("Group name"),
    email: z.string().describe("Member email address"),
    name: z.string().optional().describe("Member display name"),
    vars: z.record(z.string()).optional().describe("Template variables for this member"),
  },
  async ({ group_name, email, name, vars }) => {
    try {
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const member = addMember(group.id, email, name, vars);
      return { content: [{ type: "text", text: JSON.stringify(member, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "remove_group_member",
  "Remove a member from a recipient group",
  {
    group_name: z.string().describe("Group name"),
    email: z.string().describe("Member email address"),
  },
  async ({ group_name, email }) => {
    try {
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const removed = removeMember(group.id, email);
      if (!removed) throw new Error(`Member not found: ${email}`);
      return { content: [{ type: "text", text: `Member removed: ${email} from ${group_name}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_group_members",
  "List all members of a recipient group",
  {
    group_name: z.string().describe("Group name"),
  },
  async ({ group_name }) => {
    try {
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const members = listMembers(group.id);
      return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── SANDBOX ─────────────────────────────────────────────────────────────────

  server.tool(
  "list_sandbox_emails",
  "List emails captured by sandbox providers (not actually sent)",
  {
    provider_id: z.string().optional().describe("Filter by sandbox provider ID"),
    limit: z.number().optional().describe("Max results (default 50)"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
  },
  async ({ provider_id, limit, offset }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const emails = listSandboxEmails(resolvedId, limit ?? 50, offset ?? 0);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "get_sandbox_email",
  "Get a specific sandbox-captured email by ID",
  {
    id: z.string().describe("Sandbox email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "sandbox_emails", id);
      if (!resolvedId) throw new Error(`Sandbox email not found: ${id}`);
      const email = getSandboxEmail(resolvedId, db);
      if (!email) throw new Error(`Sandbox email not found: ${id}`);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "clear_sandbox_emails",
  "Delete captured sandbox emails",
  {
    provider_id: z.string().optional().describe("Only clear emails for this provider (clears all if not specified)"),
  },
  async ({ provider_id }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const count = clearSandboxEmails(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify({ deleted: count }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── ANALYTICS ────────────────────────────────────────────────────────────────

  server.tool(
  "get_analytics",
  "Get email analytics — daily volume, top recipients, busiest hours, delivery trend",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    period: z.string().optional().describe("Time period, e.g. '30d', '7d' (default: 30d)"),
  },
  async ({ provider_id, period }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const { getAnalytics } = await import("../../lib/analytics.js");
      const data = getAnalytics(resolvedId, period ?? "30d");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── DOCTOR ───────────────────────────────────────────────────────────────────

  server.tool(
  "run_doctor",
  "Run full email system diagnostics — check credentials, domains, DB, config",
  {},
  async () => {
    try {
      const { runDiagnostics } = await import("../../lib/doctor.js");
      const checks = await runDiagnostics();
      return { content: [{ type: "text", text: JSON.stringify(checks, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── EXPORT ───────────────────────────────────────────────────────────────────

  server.tool(
  "export_emails",
  "Export emails as CSV or JSON string",
  {
    format: z.enum(["csv", "json"]).optional().describe("Output format (default: json)"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 datetime to filter from"),
  },
  async ({ format, provider_id, since }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const filters = { provider_id: resolvedId, since };
      const { exportEmailsCsv, exportEmailsJson } = await import("../../lib/export.js");
      const output = (format ?? "json") === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "export_events",
  "Export events as CSV or JSON string",
  {
    format: z.enum(["csv", "json"]).optional().describe("Output format (default: json)"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 datetime to filter from"),
  },
  async ({ format, provider_id, since }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const filters = { provider_id: resolvedId, since };
      const { exportEventsCsv, exportEventsJson } = await import("../../lib/export.js");
      const output = (format ?? "json") === "csv" ? exportEventsCsv(filters) : exportEventsJson(filters);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────

  server.tool(
  "verify_email_address",
  "Verify an email address — checks format, MX records, and optionally SMTP probe",
  {
    email: z.string().describe("Email address to verify"),
    smtp_probe: z.boolean().optional().describe("Also do SMTP probe (RCPT TO check, no email sent)"),
    timeout_ms: z.number().optional().describe("DNS/SMTP timeout in milliseconds (default: 5000)"),
  },
  async ({ email, smtp_probe, timeout_ms }) => {
    try {
      const { verifyEmailAddress, formatVerifyResult } = await import("../../lib/email-verify.js");
      const result = await verifyEmailAddress(email, { smtpProbe: !!smtp_probe, timeoutMs: timeout_ms ?? 5000 });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) + "\n\n" + formatVerifyResult(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── BATCH SEND ───────────────────────────────────────────────────────────────

  server.tool(
  "batch_send",
  "Send emails to a list of recipients using a template. Each recipient gets personalized content.",
  {
    recipients: z.array(z.object({ email: z.string(), vars: z.record(z.string()).optional() })).describe("List of recipients with optional template variables"),
    template_name: z.string().describe("Template name to use"),
    from_address: z.string().describe("From email address"),
    provider_id: z.string().optional().describe("Provider ID (uses default if not specified)"),
    force: z.boolean().optional().describe("Send even to suppressed contacts"),
  },
  async ({ recipients, template_name, from_address, provider_id, force }) => {
    try {
      const { getTemplate, renderTemplate } = await import("../../db/templates.js");
      const template = getTemplate(template_name);
      if (!template) throw new Error(`Template not found: ${template_name}`);
      const { getActiveProvider, getProvider } = await import("../../db/providers.js");
      const db = getDatabase();
      const resolvedProviderId = provider_id ? resolvePartialId(db, "providers", provider_id) ?? provider_id
        : getActiveProvider(db).id;
      const provider = getProvider(resolvedProviderId, db);
      if (!provider) throw new ProviderNotFoundError(resolvedProviderId);
      const { isContactSuppressed, incrementSendCount } = await import("../../db/contacts.js");
      const { createEmail } = await import("../../db/emails.js");
      let sent = 0, skipped = 0, failed = 0;
      const errors: string[] = [];
      for (const r of recipients) {
        if (!force && isContactSuppressed(r.email, db)) { skipped++; continue; }
        try {
          const vars = r.vars ?? { email: r.email };
          const subject = renderTemplate(template.subject_template, vars);
          const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
          const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;
          const { messageId, providerId: actualId } = await sendWithFailover(resolvedProviderId, { from: from_address, to: r.email, subject, html, text }, db);
          createEmail(actualId, { from: from_address, to: r.email, subject, html, text }, messageId, db);
          incrementSendCount(r.email, db);
          sent++;
        } catch (e) { failed++; errors.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return { content: [{ type: "text", text: JSON.stringify({ sent, skipped, failed, errors }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );
}
