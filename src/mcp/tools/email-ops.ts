// MCP tool module: email-ops.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createEmail, listEmails, getEmail, searchEmails } from '../../db/emails.js';
import { storeEmailContent, getEmailContent } from '../../db/email-content.js';
import { listEvents } from '../../db/events.js';
import { getLocalStats } from '../../lib/stats.js';
import { createTemplate, listTemplates, getTemplate, deleteTemplate, renderTemplate } from '../../db/templates.js';
import { listContacts, suppressContact, unsuppressContact } from '../../db/contacts.js';
import { createScheduledEmail, listScheduledEmails, cancelScheduledEmail } from '../../db/scheduled.js';
import { listProviders, getProvider } from '../../db/providers.js';
import { listAddresses } from '../../db/addresses.js';
import { getTemplate as getTemplateFn, renderTemplate as renderTemplateFn } from '../../db/templates.js';
import { getGroupByName, listMembers } from '../../db/groups.js';
import { getDatabase, resolvePartialId } from '../../db/database.js';
import { getDefaultProviderId, getFailoverProviderIds } from '../../lib/config.js';
import { sendWithFailover } from '../../lib/send.js';
import { isContactSuppressed, incrementSendCount } from '../../db/contacts.js';
import { formatError, resolveId, EmailNotFoundError } from '../helpers.js';

export function registerEmailOpsTools(server: McpServer): void {
  // ─── SEND EMAIL ───────────────────────────────────────────────────────────────

  server.tool(
  "send_email",
  "Send an email via the configured provider",
  {
    from: z.string().describe("Sender email address"),
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient(s)"),
    subject: z.string().optional().describe("Email subject (required if no template)"),
    html: z.string().optional().describe("HTML body"),
    text: z.string().optional().describe("Plain text body"),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe("CC recipients"),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe("BCC recipients"),
    reply_to: z.string().optional().describe("Reply-to address"),
    provider_id: z.string().optional().describe("Provider ID (uses active provider if not specified)"),
    template: z.string().optional().describe("Template name to use"),
    template_vars: z.record(z.string()).optional().describe("Variables to render into the template"),
    attachments: z
      .array(
        z.object({
          filename: z.string(),
          content: z.string().describe("Base64 encoded content"),
          content_type: z.string(),
        }),
      )
      .optional()
      .describe("Email attachments"),
    tags: z.record(z.string()).optional().describe("Key-value tags"),
    headers: z.record(z.string()).optional().describe("Custom email headers"),
    unsubscribe_url: z.string().optional().describe("Auto-inject List-Unsubscribe headers (RFC 8058 one-click)"),
    idempotency_key: z.string().optional().describe("Prevent duplicate sends — returns existing email if key was used before"),
  },
  async (input) => {
    try {
      const db = getDatabase();

      // Resolve template
      let subject = input.subject || "";
      let html = input.html;
      let text = input.text;

      if (input.template) {
        const tpl = getTemplate(input.template, db);
        if (!tpl) throw new Error(`Template not found: ${input.template}`);
        const vars = input.template_vars || {};
        subject = renderTemplate(tpl.subject_template, vars);
        if (tpl.html_template) html = renderTemplate(tpl.html_template, vars);
        if (tpl.text_template) text = renderTemplate(tpl.text_template, vars);
      }

      if (!subject) throw new Error("Subject is required (provide subject or template)");

      let providerId: string;

      if (input.provider_id) {
        providerId = resolveId("providers", input.provider_id);
      } else {
        const active = getActiveProvider(db);
        providerId = active.id;
      }

      const provider = getProvider(providerId, db);
      if (!provider) throw new ProviderNotFoundError(providerId);

      // Check domain warming limits
      const fromDomain = input.from?.split("@")[1];
      if (fromDomain) {
        const warmingSchedule = getWarmingSchedule(fromDomain, db);
        if (warmingSchedule) {
          const limit = getTodayLimit(warmingSchedule);
          if (limit !== null) {
            const sent = getTodaySentCount(fromDomain, db);
            if (sent >= limit) {
              throw new Error(`Warming limit reached for ${fromDomain}: ${sent}/${limit} emails sent today. Increase limit or wait until tomorrow.`);
            }
          }
        }
      }

      const sendInput = { ...input, subject, html, text };
      const { messageId, providerId: actualProviderId } = await sendWithFailover(providerId, sendInput, db);

      const email = createEmail(actualProviderId, sendInput, messageId, db);

      // Store email content
      storeEmailContent(email.id, { html, text }, db);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, email_id: email.id, message_id: messageId }, null, 2),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── EMAILS ───────────────────────────────────────────────────────────────────

  server.tool(
  "list_emails",
  "List sent emails with optional filters",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    status: z
      .enum(["sent", "delivered", "bounced", "complained", "failed"])
      .optional()
      .describe("Filter by status"),
    since: z.string().optional().describe("ISO timestamp — only show emails after this"),
    limit: z.number().optional().describe("Max results (default 50)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
  async (input) => {
    try {
      const resolvedProviderId = input.provider_id
        ? resolveId("providers", input.provider_id)
        : undefined;
      const emails = listEmails({
        ...input,
        provider_id: resolvedProviderId,
        limit: input.limit ?? 50,
      });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "search_emails",
  "Search emails by subject, from address, or to address",
  {
    query: z.string().describe("Search query (matches subject, from, or to)"),
    since: z.string().optional().describe("ISO timestamp — only show emails after this"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ query, since, limit }) => {
    try {
      const emails = searchEmails(query, { since, limit: limit ?? 50 });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "get_email",
  "Get details of a specific email",
  {
    email_id: z.string().describe("Email ID (or prefix)"),
  },
  async ({ email_id }) => {
    try {
      const id = resolveId("emails", email_id);
      const email = getEmail(id);
      if (!email) throw new EmailNotFoundError(id);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "get_email_content",
  "Get the full content (body, headers) of a sent email",
  {
    email_id: z.string().describe("Email ID (or prefix)"),
  },
  async ({ email_id }) => {
    try {
      const id = resolveId("emails", email_id);
      const email = getEmail(id);
      if (!email) throw new EmailNotFoundError(id);
      const content = getEmailContent(id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ email, content: content || { html: null, text_body: null, headers: {} } }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── EVENTS ───────────────────────────────────────────────────────────────────

  server.tool(
  "pull_events",
  "Pull latest events from provider(s) and store locally",
  {
    provider_id: z.string().optional().describe("Provider ID (syncs all if not specified)"),
  },
  async ({ provider_id }) => {
    try {
      let result: Record<string, number>;
      if (provider_id) {
        const id = resolveId("providers", provider_id);
        const count = await syncProvider(id);
        result = { [id]: count };
      } else {
        result = await syncAll();
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── STATS ────────────────────────────────────────────────────────────────────

  server.tool(
  "get_stats",
  "Get email delivery statistics",
  {
    provider_id: z.string().optional().describe("Provider ID (all providers if not specified)"),
    period: z.string().optional().describe("Period: 7d, 30d, 90d (default 30d)"),
  },
  async ({ provider_id, period }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const stats = getLocalStats(resolvedId, period ?? "30d");
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── TEMPLATES ───────────────────────────────────────────────────────────────

  server.tool(
  "list_templates",
  "List all email templates",
  {},
  async () => {
    try {
      const templates = listTemplates();
      return { content: [{ type: "text", text: JSON.stringify(templates, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_template",
  "Create a new email template",
  {
    name: z.string().describe("Unique template name"),
    subject_template: z.string().describe("Subject template (supports {{var}} placeholders)"),
    html_template: z.string().optional().describe("HTML body template"),
    text_template: z.string().optional().describe("Plain text body template"),
  },
  async (input) => {
    try {
      const template = createTemplate(input);
      return { content: [{ type: "text", text: JSON.stringify(template, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "remove_template",
  "Delete a template by name or ID",
  {
    name_or_id: z.string().describe("Template name or ID"),
  },
  async ({ name_or_id }) => {
    try {
      const deleted = deleteTemplate(name_or_id);
      if (!deleted) throw new Error(`Template not found: ${name_or_id}`);
      return { content: [{ type: "text", text: `Template removed: ${name_or_id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── CONTACTS ────────────────────────────────────────────────────────────────

  server.tool(
  "list_contacts",
  "List tracked email contacts",
  {
    suppressed: z.boolean().optional().describe("Filter by suppression status"),
  },
  async ({ suppressed }) => {
    try {
      const contacts = listContacts(suppressed !== undefined ? { suppressed } : undefined);
      return { content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "suppress_contact",
  "Suppress a contact email (prevent sending)",
  {
    email: z.string().describe("Email address to suppress"),
  },
  async ({ email }) => {
    try {
      suppressContact(email);
      return { content: [{ type: "text", text: `Contact suppressed: ${email}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "unsuppress_contact",
  "Unsuppress a contact email (allow sending again)",
  {
    email: z.string().describe("Email address to unsuppress"),
  },
  async ({ email }) => {
    try {
      unsuppressContact(email);
      return { content: [{ type: "text", text: `Contact unsuppressed: ${email}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );


  // ─── SCHEDULED ──────────────────────────────────────────────────────────────

  server.tool(
  "schedule_email",
  "Schedule an email to be sent later",
  {
    from: z.string().describe("Sender email address"),
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient(s)"),
    subject: z.string().describe("Email subject"),
    html: z.string().optional().describe("HTML body"),
    text: z.string().optional().describe("Plain text body"),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe("CC recipients"),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe("BCC recipients"),
    reply_to: z.string().optional().describe("Reply-to address"),
    provider_id: z.string().optional().describe("Provider ID (uses active provider if not specified)"),
    template: z.string().optional().describe("Template name to use"),
    template_vars: z.record(z.string()).optional().describe("Template variables"),
    scheduled_at: z.string().describe("ISO 8601 datetime to send the email"),
  },
  async (input) => {
    try {
      const db = getDatabase();
      let providerId: string;
      if (input.provider_id) {
        providerId = resolveId("providers", input.provider_id);
      } else {
        const active = getActiveProvider(db);
        providerId = active.id;
      }

      // Resolve template if provided
      let subject = input.subject;
      let html = input.html;
      let text = input.text;
      if (input.template) {
        const tpl = getTemplate(input.template, db);
        if (!tpl) throw new Error(`Template not found: ${input.template}`);
        const vars = input.template_vars || {};
        subject = renderTemplate(tpl.subject_template, vars);
        if (tpl.html_template) html = renderTemplate(tpl.html_template, vars);
        if (tpl.text_template) text = renderTemplate(tpl.text_template, vars);
      }

      const toArr = Array.isArray(input.to) ? input.to : [input.to];
      const ccArr = input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : [];
      const bccArr = input.bcc ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]) : [];

      const scheduled = createScheduledEmail({
        provider_id: providerId,
        from_address: input.from,
        to_addresses: toArr,
        cc_addresses: ccArr,
        bcc_addresses: bccArr,
        reply_to: input.reply_to,
        subject,
        html,
        text_body: text,
        template_name: input.template,
        template_vars: input.template_vars,
        scheduled_at: input.scheduled_at,
      }, db);

      return { content: [{ type: "text", text: JSON.stringify(scheduled, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_scheduled",
  "List scheduled emails",
  {
    status: z.enum(["pending", "sent", "cancelled", "failed"]).optional().describe("Filter by status"),
  },
  async ({ status }) => {
    try {
      const emails = listScheduledEmails(status ? { status } : undefined);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "cancel_scheduled",
  "Cancel a pending scheduled email",
  {
    id: z.string().describe("Scheduled email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      const resolvedId = resolveId("scheduled_emails", id);
      const cancelled = cancelScheduledEmail(resolvedId);
      if (!cancelled) throw new Error(`Cannot cancel email ${id} (may already be sent or cancelled)`);
      return { content: [{ type: "text", text: `Scheduled email cancelled: ${resolvedId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

}
