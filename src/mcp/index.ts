#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { z } from "zod";
import { createProvider, listProviders, deleteProvider, getProvider, getActiveProvider, updateProvider } from "../db/providers.js";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../db/addresses.js";
import { createEmail, listEmails, getEmail, searchEmails } from "../db/emails.js";
import { createTemplate, listTemplates, getTemplate, deleteTemplate, renderTemplate } from "../db/templates.js";
import { listContacts, suppressContact, unsuppressContact } from "../db/contacts.js";
import { createScheduledEmail, listScheduledEmails, cancelScheduledEmail } from "../db/scheduled.js";
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMembers, getMemberCount } from "../db/groups.js";
import {
  createSequence, getSequence, listSequences,
  addStep,
  enroll, unenroll, listEnrollments,
} from "../db/sequences.js";
import { storeEmailContent, getEmailContent } from "../db/email-content.js";
import { listSandboxEmails, getSandboxEmail, clearSandboxEmails } from "../db/sandbox.js";
import { listInboundEmails, getInboundEmail, clearInboundEmails, listReplies, getReplyCount } from "../db/inbound.js";
import { syncGmailInbox, syncGmailInboxAll } from "../lib/gmail-sync.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";
import { sendWithFailover } from "../lib/send.js";
import {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
} from "../types/index.js";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../db/warming.js";
import { getTodayLimit, getTodaySentCount, generateWarmingPlan } from "../lib/warming.js";

// --- in-memory agent registry ---
interface _EmailAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
const _emailAgents = new Map<string, _EmailAgent>();

const server = new McpServer({
  name: "emails",
  version: "0.1.0",
});

function formatError(error: unknown): string {
  if (error instanceof ProviderNotFoundError) return `Provider not found: ${error.providerId}`;
  if (error instanceof DomainNotFoundError) return `Domain not found: ${error.domainId}`;
  if (error instanceof AddressNotFoundError) return `Address not found: ${error.addressId}`;
  if (error instanceof EmailNotFoundError) return `Email not found: ${error.emailId}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

// ─── DOMAINS ──────────────────────────────────────────────────────────────────

server.tool(
  "list_domains",
  "List domains, optionally filtered by provider",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
  },
  async ({ provider_id }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const domains = listDomains(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify(domains, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "add_domain",
  "Add a domain to a provider",
  {
    provider_id: z.string().describe("Provider ID"),
    domain: z.string().describe("Domain name (e.g. example.com)"),
  },
  async ({ provider_id, domain }) => {
    try {
      const resolvedId = resolveId("providers", provider_id);
      const provider = getProvider(resolvedId);
      if (!provider) throw new ProviderNotFoundError(resolvedId);

      const adapter = getAdapter(provider);
      await adapter.addDomain(domain);

      const d = createDomain(resolvedId, domain);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_dns_records",
  "Get DNS records required for a domain",
  {
    domain: z.string().describe("Domain name"),
    provider_id: z.string().optional().describe("Provider ID (optional)"),
  },
  async ({ domain, provider_id }) => {
    try {
      let provider;
      if (provider_id) {
        const resolvedId = resolveId("providers", provider_id);
        provider = getProvider(resolvedId);
      } else {
        // Find provider for this domain
        const domains = listDomains();
        const found = domains.find((d) => d.domain === domain);
        if (found) provider = getProvider(found.provider_id);
      }

      if (!provider) {
        // Return generic records
        const { generateSpfRecord, generateDmarcRecord, formatDnsTable } = await import("../lib/dns.js");
        const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
        return { content: [{ type: "text", text: formatDnsTable(records) }] };
      }

      const adapter = getAdapter(provider);
      const records = await adapter.getDnsRecords(domain);
      const { formatDnsTable } = await import("../lib/dns.js");
      return { content: [{ type: "text", text: formatDnsTable(records) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "verify_domain",
  "Re-verify a domain's DNS status",
  {
    domain: z.string().describe("Domain name"),
    provider_id: z.string().optional().describe("Provider ID (optional)"),
  },
  async ({ domain, provider_id }) => {
    try {
      const domains = listDomains(provider_id ? resolveId("providers", provider_id) : undefined);
      const found = domains.find((d) => d.domain === domain);
      if (!found) throw new DomainNotFoundError(domain);

      const provider = getProvider(found.provider_id);
      if (!provider) throw new ProviderNotFoundError(found.provider_id);

      const adapter = getAdapter(provider);
      const status = await adapter.verifyDomain(domain);
      const updated = updateDnsStatus(found.id, status.dkim, status.spf, status.dmarc);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "remove_domain",
  "Remove a domain by ID",
  {
    domain_id: z.string().describe("Domain ID (or prefix)"),
  },
  async ({ domain_id }) => {
    try {
      const id = resolveId("domains", domain_id);
      const domain = getDomain(id);
      if (!domain) throw new DomainNotFoundError(id);
      deleteDomain(id);
      return { content: [{ type: "text", text: `Domain removed: ${domain.domain}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── ADDRESSES ────────────────────────────────────────────────────────────────

server.tool(
  "list_addresses",
  "List sender email addresses",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
  },
  async ({ provider_id }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const addresses = listAddresses(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify(addresses, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "add_address",
  "Add a sender email address",
  {
    provider_id: z.string().describe("Provider ID"),
    email: z.string().describe("Email address"),
    display_name: z.string().optional().describe("Display name"),
  },
  async ({ provider_id, email, display_name }) => {
    try {
      const resolvedId = resolveId("providers", provider_id);
      const provider = getProvider(resolvedId);
      if (!provider) throw new ProviderNotFoundError(resolvedId);

      const adapter = getAdapter(provider);
      await adapter.addAddress(email);

      const addr = createAddress({ provider_id: resolvedId, email, display_name });
      return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "verify_address",
  "Check verification status of a sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      const addr = getAddress(id);
      if (!addr) throw new AddressNotFoundError(id);

      const provider = getProvider(addr.provider_id);
      if (!provider) throw new ProviderNotFoundError(addr.provider_id);

      const adapter = getAdapter(provider);
      const verified = await adapter.verifyAddress(addr.email);

      if (verified) {
        const db = getDatabase();
        db.run("UPDATE addresses SET verified = 1, updated_at = datetime('now') WHERE id = ?", [id]);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ email: addr.email, verified }, null, 2),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "remove_address",
  "Remove a sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      const addr = getAddress(id);
      if (!addr) throw new AddressNotFoundError(id);
      deleteAddress(id);
      return { content: [{ type: "text", text: `Address removed: ${addr.email}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

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
  },
  async ({ provider_id, limit }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const emails = listSandboxEmails(resolvedId, limit ?? 50);
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
      const { getAnalytics } = await import("../lib/analytics.js");
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
      const { runDiagnostics } = await import("../lib/doctor.js");
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
      const { exportEmailsCsv, exportEmailsJson } = await import("../lib/export.js");
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
      const { exportEventsCsv, exportEventsJson } = await import("../lib/export.js");
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
      const { verifyEmailAddress, formatVerifyResult } = await import("../lib/email-verify.js");
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
      const { getTemplate, renderTemplate } = await import("../db/templates.js");
      const template = getTemplate(template_name);
      if (!template) throw new Error(`Template not found: ${template_name}`);
      const { getActiveProvider, getProvider } = await import("../db/providers.js");
      const db = getDatabase();
      const resolvedProviderId = provider_id ? resolvePartialId(db, "providers", provider_id) ?? provider_id
        : getActiveProvider(db).id;
      const provider = getProvider(resolvedProviderId, db);
      if (!provider) throw new ProviderNotFoundError(resolvedProviderId);
      const { isContactSuppressed, incrementSendCount } = await import("../db/contacts.js");
      const { createEmail } = await import("../db/emails.js");
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
// ─── DOMAIN PURCHASING (via @hasna/domains / Route 53) ───────────────────────

server.tool(
  "check_domain_availability",
  "Check if a domain is available for purchase via AWS Route 53 and get pricing",
  { domain: z.string().describe("Domain to check (e.g. example.com)") },
  async ({ domain }) => {
    try {
      const { r53CheckAvailability } = await import("@hasna/domains");
      const result = await r53CheckAvailability(domain);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "register_domain",
  "Purchase and register a domain via AWS Route 53. Returns an operation ID to track progress.",
  {
    domain: z.string(),
    first_name: z.string(), last_name: z.string(),
    email: z.string(), phone: z.string().describe("E.164 format, e.g. +1.5551234567"),
    address_line_1: z.string(), city: z.string(), state: z.string(),
    country_code: z.string().describe("Two-letter country code, e.g. US"),
    zip_code: z.string(),
    organization_name: z.string().optional(),
    duration_years: z.number().optional().describe("Registration years (default: 1)"),
  },
  async (params) => {
    try {
      const { r53RegisterDomain } = await import("@hasna/domains");
      const result = await r53RegisterDomain(params.domain, {
        first_name: params.first_name, last_name: params.last_name,
        email: params.email, phone: params.phone,
        address_line_1: params.address_line_1, city: params.city,
        state: params.state, country_code: params.country_code,
        zip_code: params.zip_code, organization_name: params.organization_name,
      }, params.duration_years ?? 1);
      return { content: [{ type: "text", text: JSON.stringify({ domain: params.domain, ...result }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "get_domain_registration_status",
  "Check the status of a domain registration operation",
  { operation_id: z.string() },
  async ({ operation_id }) => {
    try {
      const { r53GetRegistrationStatus } = await import("@hasna/domains");
      return { content: [{ type: "text", text: JSON.stringify(await r53GetRegistrationStatus(operation_id), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "list_registered_domains",
  "List all domains registered in AWS Route 53",
  {},
  async () => {
    try {
      const { r53ListRegisteredDomains } = await import("@hasna/domains");
      return { content: [{ type: "text", text: JSON.stringify(await r53ListRegisteredDomains(), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "setup_domain_for_email",
  "Full setup: buy domain + create Route 53 hosted zone + register with SES + configure DKIM/SPF/DMARC DNS records. One call to go from domain name to fully configured email sending.",
  {
    domain: z.string().describe("Domain to set up"),
    provider_id: z.string().describe("SES or Resend provider ID"),
    contact: z.object({
      first_name: z.string(), last_name: z.string(), email: z.string(),
      phone: z.string(), address_line_1: z.string(), city: z.string(),
      state: z.string(), country_code: z.string(), zip_code: z.string(),
      organization_name: z.string().optional(),
    }).optional().describe("Registrant contact info (omit if domain already purchased)"),
    duration_years: z.number().optional(),
  },
  async ({ domain, provider_id, contact, duration_years }) => {
    try {
      const { r53CheckAvailability, r53RegisterDomain, r53CreateHostedZone, r53FindHostedZoneByDomain, r53UpsertRecords } = await import("@hasna/domains");

      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);

      const steps: string[] = [];

      // 1. Buy domain if contact info provided
      let operationId: string | undefined;
      if (contact) {
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) throw new Error(`${domain} is not available for registration`);
        steps.push(`availability: ${avail.available}, price: ${avail.price ?? "unknown"} ${avail.currency ?? ""}`);
        const reg = await r53RegisterDomain(domain, contact, duration_years ?? 1);
        operationId = reg.operationId;
        steps.push(`registration submitted, operation_id: ${operationId}`);
      }

      // 2. Find or create hosted zone
      let zone = await r53FindHostedZoneByDomain(domain);
      if (!zone) {
        zone = await r53CreateHostedZone(domain, `Email sending for ${domain}`);
        steps.push(`hosted zone created: ${zone.id}`);
      } else {
        steps.push(`using existing zone: ${zone.id}`);
      }

      // 3. Register with SES + get DNS records
      const adapter = getAdapter(provider);
      await adapter.addDomain(domain);
      createDomain(resolveId("providers", provider_id), domain);
      steps.push("domain registered with SES");

      // 4. Create DNS records in Route 53
      const dnsRecords = await adapter.getDnsRecords(domain);
      const r53Recs = dnsRecords.map((r) => ({
        name: r.name, type: r.type, ttl: 300,
        values: r.type === "TXT" ? [`"${r.value}"`] : [r.value],
      }));
      await r53UpsertRecords(zone.id, r53Recs);
      steps.push(`${r53Recs.length} DNS records created (DKIM, SPF, DMARC)`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            domain, zone_id: zone.id, operation_id: operationId ?? null,
            steps, next: `Run verify to check DNS propagation: emails domain verify ${domain} --provider ${provider_id}`,
          }, null, 2),
        }],
      };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

// ─── CLOUDFLARE DNS ───────────────────────────────────────────────────────────

server.tool(
  "get_cloudflare_zone",
  "Find the Cloudflare zone ID for a domain. Looks up zone by domain name.",
  {
    domain: z.string().describe("Domain name to look up"),
    cloudflare_token: z.string().optional().describe("Cloudflare API token (falls back to config/env)"),
  },
  async ({ domain, cloudflare_token }) => {
    try {
      const { getCloudflare, findZone } = await import("../lib/cloudflare-dns.js");
      const cf = getCloudflare(cloudflare_token);
      const zone = await findZone(cf, domain);
      if (!zone) return { content: [{ type: "text", text: `No Cloudflare zone found for ${domain}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(zone, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "setup_cloudflare_dns",
  "Automatically create all email DNS records (DKIM, SPF, DMARC, optionally MX) in Cloudflare for a domain. Skips records that already exist.",
  {
    domain: z.string().describe("Domain to configure"),
    provider_id: z.string().describe("SES or Resend provider ID"),
    cloudflare_token: z.string().optional().describe("Cloudflare API token (falls back to cloudflare_api_token config or CLOUDFLARE_API_TOKEN env)"),
    add_mx: z.boolean().optional().describe("Also add MX record for receiving email"),
    mx_server: z.string().optional().describe("Custom MX server hostname (default: inbound-smtp.<region>.amazonaws.com for SES)"),
    register_domain: z.boolean().optional().describe("Register the domain with SES/Resend first if not already added"),
  },
  async ({ domain, provider_id, cloudflare_token, add_mx, mx_server, register_domain }) => {
    try {
      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);

      if (register_domain) {
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        createDomain(resolveId("providers", provider_id), domain);
      }

      const { setupEmailDns } = await import("../lib/cloudflare-dns.js");
      const result = await setupEmailDns({
        domain,
        provider,
        apiToken: cloudflare_token,
        addMx: add_mx,
        mxServer: mx_server,
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "sync_s3_inbox",
  "Sync inbound emails from an S3 bucket (stored by SES receipt rules) into local DB. Parses raw RFC 2822 email files.",
  {
    bucket: z.string().describe("S3 bucket name"),
    prefix: z.string().optional().describe("S3 key prefix (e.g. inbound/example.com/)"),
    region: z.string().optional().describe("AWS region (default: us-east-1)"),
    provider_id: z.string().optional().describe("Associate emails with this provider ID"),
    limit: z.number().optional().describe("Max emails per run (default: 100)"),
  },
  async ({ bucket, prefix, region, provider_id, limit }) => {
    try {
      const { syncS3Inbox } = await import("../lib/s3-sync.js");
      const result = await syncS3Inbox({ bucket, prefix, region, providerId: provider_id, limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "setup_ses_inbound",
  "Create S3 bucket + SES receipt rules to receive inbound email for a domain",
  {
    domain: z.string().describe("Domain to receive email for"),
    bucket: z.string().describe("S3 bucket name to create/use"),
    region: z.string().optional().describe("AWS region (default: us-east-1)"),
    prefix: z.string().optional().describe("S3 key prefix"),
    catch_all: z.boolean().optional().describe("Also catch subdomains"),
  },
  async ({ domain, bucket, region, prefix, catch_all }) => {
    try {
      const { setupInboundEmail } = await import("../lib/aws-inbound.js");
      const result = await setupInboundEmail({ domain, bucket, region, prefix, catchAll: catch_all });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── CONFIG ───────────────────────────────────────────────────────────────────

import { loadConfig, saveConfig, getConfigValue, setConfigValue } from "../lib/config.js";

server.tool(
  "get_config",
  "Get a configuration value by key",
  { key: z.string().describe("Config key (e.g. gmail_attachment_storage, gmail_s3_bucket, default_provider)") },
  async ({ key }) => {
    try {
      const value = getConfigValue(key);
      return { content: [{ type: "text", text: value === undefined ? `${key} is not set` : JSON.stringify({ [key]: value }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "set_config",
  "Set a configuration value. Known keys: gmail_attachment_storage (local|s3|none), gmail_s3_bucket, gmail_s3_prefix, gmail_s3_region, default_provider, failover-providers",
  {
    key: z.string().describe("Config key"),
    value: z.string().describe("Config value (strings, numbers, or JSON)"),
  },
  async ({ key, value }) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      setConfigValue(key, parsed);
      return { content: [{ type: "text", text: `✓ ${key} = ${JSON.stringify(parsed)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_config",
  "List all configuration values",
  {},
  async () => {
    try {
      const config = loadConfig();
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── Feedback ────────────────────────────────────────────────────────────────

server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string(),
    email: z.string().optional(),
    category: z.enum(["bug", "feature", "general"]).optional(),
  },
  async (params) => {
    try {
      const db = getDatabase();
      const pkg = require("../../package.json");
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message, params.email || null, params.category || "general", pkg.version,
      ]);
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  },
);

// ─── Agent Tools ──────────────────────────────────────────────────────────────

server.tool("register_agent", "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.", {
  name: z.string(),
  session_id: z.string().optional(),
}, async (params) => {
  const existing = [..._emailAgents.values()].find(a => a.name === params.name);
  if (existing) { existing.last_seen_at = new Date().toISOString(); if (params.session_id) existing.session_id = params.session_id; return { content: [{ type: "text" as const, text: JSON.stringify(existing) }] }; }
  const id = Math.random().toString(36).slice(2, 10);
  const ag: _EmailAgent = { id, name: params.name, session_id: params.session_id, last_seen_at: new Date().toISOString() };
  _emailAgents.set(id, ag);
  return { content: [{ type: "text" as const, text: JSON.stringify(ag) }] };
});

server.tool("heartbeat", "Update last_seen_at to signal agent is active.", {
  agent_id: z.string(),
}, async (params) => {
  const ag = _emailAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.last_seen_at = new Date().toISOString();
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, last_seen_at: ag.last_seen_at }) }] };
});

server.tool("set_focus", "Set active project context for this agent session.", {
  agent_id: z.string(),
  project_id: z.string().optional(),
}, async (params) => {
  const ag = _emailAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.project_id = params.project_id;
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, project_id: ag.project_id ?? null }) }] };
});

server.tool("list_agents", "List all registered agents.", {}, async () => {
  return { content: [{ type: "text" as const, text: JSON.stringify([..._emailAgents.values()]) }] };
});

// ─── Tool modules ────────────────────────────────────────────────────────────

import { registerTriageTools } from "./tools/triage.js";
import { registerWarmingTools } from "./tools/warming.js";
import { registerProviderTools } from "./tools/providers.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerSequenceTools } from "./tools/sequences.js";

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  registerCloudTools(server, "emails");
  registerTriageTools(server);
  registerWarmingTools(server);
  registerProviderTools(server);
  registerInboxTools(server);
  registerSequenceTools(server);
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
