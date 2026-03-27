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

// ─── PROVIDERS ────────────────────────────────────────────────────────────────

server.tool(
  "list_providers",
  "List all configured email providers",
  {},
  async () => {
    try {
      const providers = listProviders();
      return { content: [{ type: "text", text: JSON.stringify(providers, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "add_provider",
  "Add a new email provider (resend, ses, or gmail)",
  {
    name: z.string().describe("Provider name"),
    type: z.enum(["resend", "ses", "gmail", "sandbox"]).describe("Provider type"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region (e.g. us-east-1)"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
    oauth_client_id: z.string().optional().describe("Gmail OAuth client ID"),
    oauth_client_secret: z.string().optional().describe("Gmail OAuth client secret"),
    oauth_refresh_token: z.string().optional().describe("Gmail OAuth refresh token"),
    oauth_access_token: z.string().optional().describe("Gmail OAuth access token"),
    oauth_token_expiry: z.string().optional().describe("Gmail OAuth token expiry (ISO 8601)"),
    skip_validation: z.boolean().optional().describe("Skip credential validation after adding (default: false)"),
  },
  async (input) => {
    try {
      const { skip_validation, ...providerInput } = input;
      const provider = createProvider(providerInput);

      if (!skip_validation && provider.type !== "sandbox") {
        try {
          const adapter = getAdapter(provider);
          if (provider.type === "gmail") {
            await adapter.listAddresses();
          } else {
            await adapter.listDomains();
          }
        } catch (validationErr) {
          deleteProvider(provider.id);
          return {
            content: [{
              type: "text",
              text: `Error: Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`,
            }],
            isError: true,
          };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(provider, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "update_provider",
  "Update an existing email provider's configuration",
  {
    id: z.string().describe("Provider ID (or prefix)"),
    name: z.string().optional().describe("New provider name"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
    oauth_client_id: z.string().optional().describe("Gmail OAuth client ID"),
    oauth_client_secret: z.string().optional().describe("Gmail OAuth client secret"),
    oauth_refresh_token: z.string().optional().describe("Gmail OAuth refresh token"),
    oauth_access_token: z.string().optional().describe("Gmail OAuth access token"),
    oauth_token_expiry: z.string().optional().describe("Gmail OAuth token expiry (ISO 8601)"),
  },
  async (input) => {
    try {
      const resolvedId = resolveId("providers", input.id);
      const { id: _, ...updates } = input;
      const updated = updateProvider(resolvedId, updates);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "authenticate_gmail_provider",
  "Trigger Gmail OAuth re-authentication flow for an existing Gmail provider. Opens a browser window. Must be run in an interactive terminal.",
  {
    provider_id: z.string().describe("Gmail provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    try {
      const id = resolveId("providers", provider_id);
      const provider = getProvider(id);
      if (!provider) throw new Error(`Provider not found: ${provider_id}`);
      if (provider.type !== "gmail") throw new Error("Only Gmail providers require OAuth authentication");
      if (!provider.oauth_client_id || !provider.oauth_client_secret) {
        throw new Error("Provider is missing oauth_client_id or oauth_client_secret");
      }

      const { startGmailOAuthFlow } = await import("../lib/gmail-oauth.js");
      const tokens = await startGmailOAuthFlow(provider.oauth_client_id, provider.oauth_client_secret);

      const { updateProvider } = await import("../db/providers.js");
      const updated = updateProvider(id, {
        oauth_refresh_token: tokens.refresh_token,
        oauth_access_token: tokens.access_token,
        oauth_token_expiry: tokens.expiry,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, provider: updated }, null, 2),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "remove_provider",
  "Remove a provider by ID",
  {
    provider_id: z.string().describe("Provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    try {
      const id = resolveId("providers", provider_id);
      const provider = getProvider(id);
      if (!provider) throw new ProviderNotFoundError(id);
      deleteProvider(id);
      return { content: [{ type: "text", text: `Provider removed: ${provider.name}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

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

// ─── INBOUND EMAILS ───────────────────────────────────────────────────────────

server.tool(
  "list_inbound_emails",
  "List received inbound emails",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 date — only return emails received after this time"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ provider_id, since, limit }) => {
    try {
      const emails = listInboundEmails({ provider_id, since, limit });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_inbound_email",
  "Get a specific inbound email by ID",
  {
    id: z.string().describe("Inbound email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      const resolvedId = resolveId("inbound_emails", id);
      const email = getInboundEmail(resolvedId);
      if (!email) throw new Error(`Inbound email not found: ${id}`);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "clear_inbound_emails",
  "Delete all inbound emails, optionally filtered by provider",
  {
    provider_id: z.string().optional().describe("Only clear emails for this provider"),
  },
  async ({ provider_id }) => {
    try {
      const count = clearInboundEmails(provider_id);
      return { content: [{ type: "text", text: `Cleared ${count} inbound email(s)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── GMAIL INBOX SYNC ─────────────────────────────────────────────────────────

server.tool(
  "sync_inbox",
  "Sync Gmail inbox messages into local SQLite. Fetches new messages via the Gmail connector and stores them for offline access.",
  {
    provider_id: z.string().describe("Gmail provider ID to sync"),
    label: z.string().optional().describe("Gmail label to sync (default: INBOX)"),
    query: z.string().optional().describe("Gmail search query, e.g. 'is:unread from:someone@example.com'"),
    limit: z.number().optional().describe("Max messages per run (default: 50)"),
    since: z.string().optional().describe("Only sync messages after this ISO date"),
    all_pages: z.boolean().optional().describe("Sync all pages until done (for full backfill)"),
  },
  async ({ provider_id, label, query, limit, since, all_pages }) => {
    try {
      const db = getDatabase();
      const opts = {
        providerId: provider_id,
        labelFilter: label,
        query,
        batchSize: limit,
        since,
        db,
      };
      const result = all_pages
        ? await syncGmailInboxAll(opts)
        : await syncGmailInbox(opts);

      updateLastSynced(provider_id, undefined, db);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            synced: result.synced,
            skipped: result.skipped,
            attachments_saved: result.attachments_saved,
            errors: result.errors,
            done: result.done,
            nextPageToken: result.nextPageToken,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

async function gmailMessageAction(
  email_id: string,
  provider_id: string,
  action: (gmail: Awaited<ReturnType<(typeof import("@hasna/connect-gmail"))["Gmail"]["createWithTokens"]>>, msgId: string) => Promise<unknown>,
): Promise<string> {
  const db = getDatabase();
  const row = db.query("SELECT message_id FROM inbound_emails WHERE id = ?").get(email_id) as { message_id: string } | null;
  if (!row?.message_id) throw new Error(`No Gmail message ID for email ${email_id}`);
  const provider = getProvider(resolveId("providers", provider_id));
  if (!provider) throw new ProviderNotFoundError(provider_id);
  const { Gmail } = await import("@hasna/connect-gmail");
  const gmail = Gmail.createWithTokens({
    accessToken: provider.oauth_access_token ?? "",
    refreshToken: provider.oauth_refresh_token ?? "",
    clientId: provider.oauth_client_id ?? "",
    clientSecret: provider.oauth_client_secret ?? "",
    expiresAt: provider.oauth_token_expiry ? new Date(provider.oauth_token_expiry).getTime() : undefined,
  });
  await action(gmail, row.message_id);
  return row.message_id;
}

server.tool(
  "mark_email_read",
  "Mark a synced inbound Gmail email as read",
  { email_id: z.string(), provider_id: z.string() },
  async ({ email_id, provider_id }) => {
    try {
      await gmailMessageAction(email_id, provider_id, (g, id) => g.messages.markAsRead(id));
      return { content: [{ type: "text", text: `Marked as read: ${email_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "archive_email",
  "Archive a synced inbound Gmail email (removes from INBOX)",
  { email_id: z.string(), provider_id: z.string() },
  async ({ email_id, provider_id }) => {
    try {
      await gmailMessageAction(email_id, provider_id, (g, id) => g.messages.archive(id));
      return { content: [{ type: "text", text: `Archived: ${email_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "star_email",
  "Star a synced inbound Gmail email",
  { email_id: z.string(), provider_id: z.string() },
  async ({ email_id, provider_id }) => {
    try {
      await gmailMessageAction(email_id, provider_id, (g, id) => g.messages.star(id));
      return { content: [{ type: "text", text: `Starred: ${email_id}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

server.tool(
  "reply_to_email",
  "Reply to a synced inbound Gmail email, keeping it in the same thread",
  {
    email_id: z.string().describe("Inbound email ID (from local DB)"),
    body: z.string().describe("Reply body text"),
    provider_id: z.string().describe("Gmail provider ID"),
    is_html: z.boolean().optional().describe("Treat body as HTML (default: false)"),
  },
  async ({ email_id, body, provider_id, is_html }) => {
    try {
      const db = getDatabase();
      const row = db.query("SELECT message_id, subject FROM inbound_emails WHERE id = ?").get(email_id) as { message_id: string; subject: string } | null;
      if (!row) throw new Error(`Inbound email not found: ${email_id}`);
      if (!row.message_id) throw new Error("Email has no Gmail message ID");

      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);

      const { Gmail } = await import("@hasna/connect-gmail");
      const gmail = Gmail.createWithTokens({
        accessToken: provider.oauth_access_token ?? "",
        refreshToken: provider.oauth_refresh_token ?? "",
        clientId: provider.oauth_client_id ?? "",
        clientSecret: provider.oauth_client_secret ?? "",
        expiresAt: provider.oauth_token_expiry ? new Date(provider.oauth_token_expiry).getTime() : undefined,
      });

      const sent = await gmail.messages.reply(row.message_id, { body, isHtml: is_html ?? false });
      return { content: [{ type: "text", text: JSON.stringify({ sent_id: sent.id, replied_to: row.subject }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_attachment",
  "Get local path or S3 URL for downloaded attachments on a synced inbound email",
  {
    email_id: z.string().describe("Inbound email ID"),
    filename: z.string().optional().describe("Filter by filename (returns all if omitted)"),
  },
  async ({ email_id, filename }) => {
    try {
      const db = getDatabase();
      const row = db.query("SELECT attachment_paths FROM inbound_emails WHERE id = ?").get(email_id) as { attachment_paths: string } | null;
      if (!row) return { content: [{ type: "text", text: `Email not found: ${email_id}` }], isError: true };
      const paths = JSON.parse(row.attachment_paths ?? "[]") as Array<{ filename: string; local_path?: string; s3_url?: string; content_type: string; size: number }>;
      const filtered = filename ? paths.filter((p) => p.filename === filename) : paths;
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "search_inbound",
  "Search synced inbound emails in local SQLite by subject, sender, or body text",
  {
    query: z.string().describe("Search term to match against subject, from address, or body"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    limit: z.number().optional().describe("Max results (default: 20)"),
  },
  async ({ query, provider_id, limit }) => {
    try {
      const db = getDatabase();
      const maxResults = limit ?? 20;
      const q = query.toLowerCase();
      const emails = listInboundEmails({ provider_id, limit: maxResults * 4 }, db)
        .filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.from_address.toLowerCase().includes(q) ||
            (e.text_body ?? "").toLowerCase().includes(q),
        )
        .slice(0, maxResults);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_inbox_sync_status",
  "Get Gmail sync status for all Gmail providers — last synced time, message counts",
  {},
  async () => {
    try {
      const db = getDatabase();
      const providers = listProviders(db).filter((p) => p.type === "gmail");
      const status = providers.map((p) => {
        const state = getGmailSyncState(p.id, db);
        const count = db.query("SELECT COUNT(*) as c FROM inbound_emails WHERE provider_id = ?").get(p.id) as { c: number } | null;
        return {
          provider_id: p.id,
          provider_name: p.name,
          synced_count: count?.c ?? 0,
          last_synced_at: state?.last_synced_at ?? null,
          last_message_id: state?.last_message_id ?? null,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── SEQUENCES ────────────────────────────────────────────────────────────────

server.tool(
  "list_sequences",
  "List all email drip sequences",
  {},
  async () => {
    try {
      const sequences = listSequences();
      return { content: [{ type: "text", text: JSON.stringify(sequences, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "create_sequence",
  "Create a new email drip sequence",
  {
    name: z.string().describe("Unique sequence name"),
    description: z.string().optional().describe("Sequence description"),
  },
  async ({ name, description }) => {
    try {
      const sequence = createSequence({ name, description });
      return { content: [{ type: "text", text: JSON.stringify(sequence, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "add_sequence_step",
  "Add a step to an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    step_number: z.number().describe("Step number (1, 2, 3...)"),
    delay_hours: z.number().describe("Delay in hours before sending this step"),
    template_name: z.string().describe("Template name to use for this step"),
    from_address: z.string().optional().describe("From address override"),
    subject_override: z.string().optional().describe("Subject override"),
  },
  async ({ sequence_id, step_number, delay_hours, template_name, from_address, subject_override }) => {
    try {
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const step = addStep({
        sequence_id: seq.id,
        step_number,
        delay_hours,
        template_name,
        from_address,
        subject_override,
      });
      return { content: [{ type: "text", text: JSON.stringify(step, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "enroll_contact",
  "Enroll a contact in an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
    provider_id: z.string().optional().describe("Provider ID to use for sending"),
  },
  async ({ sequence_id, contact_email, provider_id }) => {
    try {
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const enrollment = enroll({ sequence_id: seq.id, contact_email, provider_id });
      return { content: [{ type: "text", text: JSON.stringify(enrollment, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "unenroll_contact",
  "Unenroll a contact from an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
  },
  async ({ sequence_id, contact_email }) => {
    try {
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const removed = unenroll(seq.id, contact_email);
      return { content: [{ type: "text", text: removed ? "Contact unenrolled" : "Contact was not actively enrolled" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_enrollments",
  "List sequence enrollments, optionally filtered by sequence",
  {
    sequence_id: z.string().optional().describe("Sequence ID or name to filter by"),
    status: z.enum(["active", "completed", "cancelled"]).optional().describe("Filter by enrollment status"),
  },
  async ({ sequence_id, status }) => {
    try {
      let resolvedSequenceId: string | undefined;
      if (sequence_id) {
        const seq = getSequence(sequence_id);
        if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
        resolvedSequenceId = seq.id;
      }
      const enrollments = listEnrollments({ sequence_id: resolvedSequenceId, status });
      return { content: [{ type: "text", text: JSON.stringify(enrollments, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── REPLY TRACKING ───────────────────────────────────────────────────────────

server.tool(
  "list_replies",
  "List inbound emails received as replies to a sent email",
  { email_id: z.string().describe("ID of the sent email to find replies for") },
  async ({ email_id }) => {
    try {
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "emails", email_id) ?? email_id;
      const replies = listReplies(resolvedId, db);
      const count = getReplyCount(resolvedId, db);
      return { content: [{ type: "text", text: JSON.stringify({ count, replies }, null, 2) }] };
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

// ─── WARMING ─────────────────────────────────────────────────────────────────

server.tool(
  "create_warming_schedule",
  "Create a domain warming schedule to gradually ramp up email send volume",
  {
    domain: z.string().describe("Domain to warm up (e.g. example.com)"),
    target_daily_volume: z.number().describe("Target daily send volume to reach"),
    start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (default: today)"),
    provider_id: z.string().optional().describe("Provider ID to associate with this domain"),
  },
  async ({ domain, target_daily_volume, start_date, provider_id }) => {
    try {
      const schedule = createWarmingSchedule({ domain, target_daily_volume, start_date, provider_id });
      const plan = generateWarmingPlan(target_daily_volume);
      return { content: [{ type: "text", text: JSON.stringify({ schedule, plan_days: plan.length, final_day: plan[plan.length - 1]?.day }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_warming_status",
  "Get current warming status for a domain including today's limit and sent count",
  {
    domain: z.string().describe("Domain to check"),
  },
  async ({ domain }) => {
    try {
      const schedule = getWarmingSchedule(domain);
      if (!schedule) throw new Error(`No warming schedule found for domain: ${domain}`);
      const db = getDatabase();
      const today_limit = getTodayLimit(schedule);
      const today_sent = getTodaySentCount(domain, db);
      const startDate = new Date(schedule.start_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      startDate.setHours(0, 0, 0, 0);
      const current_day = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
      return { content: [{ type: "text", text: JSON.stringify({ schedule, today_limit, today_sent, current_day }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_warming_schedules",
  "List all domain warming schedules",
  {
    status: z.enum(["active", "paused", "completed"]).optional().describe("Filter by status"),
  },
  async ({ status }) => {
    try {
      const schedules = listWarmingSchedules(status);
      return { content: [{ type: "text", text: JSON.stringify(schedules, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "update_warming_status",
  "Update the status of a domain warming schedule",
  {
    domain: z.string().describe("Domain to update"),
    status: z.enum(["active", "paused", "completed"]).describe("New status"),
  },
  async ({ domain, status }) => {
    try {
      const updated = updateWarmingStatus(domain, status);
      if (!updated) throw new Error(`No warming schedule found for domain: ${domain}`);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── TRIAGE (AI) ─────────────────────────────────────────────────────────────

import { getTriage, listTriaged, getTriageStats, deleteTriage } from "../db/triage.js";
import { triageEmail, triageBatch, generateDraftForEmail } from "../lib/triage.js";

server.tool(
  "triage_email",
  "Triage a single email using Cerebras AI — classify, prioritize, summarize, analyze sentiment, draft reply",
  {
    email_id: z.string().describe("Email ID to triage"),
    type: z.enum(["sent", "inbound"]).default("inbound").describe("Email type"),
    model: z.string().optional().describe("Cerebras model override"),
    skip_draft: z.boolean().optional().describe("Skip generating draft reply"),
  },
  async ({ email_id, type, model, skip_draft }) => {
    try {
      const result = await triageEmail(email_id, type, { model, skip_draft });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "triage_batch",
  "Triage multiple untriaged emails in batch",
  {
    type: z.enum(["sent", "inbound"]).default("inbound").describe("Email type"),
    limit: z.number().optional().default(10).describe("Max emails to triage"),
    model: z.string().optional().describe("Cerebras model override"),
    skip_draft: z.boolean().optional().describe("Skip generating draft replies"),
  },
  async ({ type, limit, model, skip_draft }) => {
    try {
      const result = await triageBatch(type, limit, { model, skip_draft });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "get_triage",
  "Get triage result for an email",
  {
    email_id: z.string().describe("Email ID"),
    type: z.enum(["sent", "inbound"]).default("sent").describe("Email type"),
  },
  async ({ email_id, type }) => {
    try {
      const result = getTriage(email_id, type);
      if (!result) return { content: [{ type: "text", text: "No triage result found" }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "list_triaged",
  "List triaged emails with optional filters",
  {
    label: z.enum(["action-required", "fyi", "urgent", "follow-up", "spam", "newsletter", "transactional"]).optional(),
    priority: z.number().min(1).max(5).optional(),
    sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
    limit: z.number().optional().default(20),
  },
  async ({ label, priority, sentiment, limit }) => {
    try {
      const results = listTriaged({ label, priority, sentiment, limit });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "triage_stats",
  "Get triage statistics — counts by label, priority, sentiment, averages",
  {},
  async () => {
    try {
      const stats = getTriageStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "generate_draft_reply",
  "Generate a draft reply for an email using Cerebras AI",
  {
    email_id: z.string().describe("Email ID"),
    type: z.enum(["sent", "inbound"]).default("sent").describe("Email type"),
    model: z.string().optional().describe("Cerebras model override"),
  },
  async ({ email_id, type, model }) => {
    try {
      const draft = await generateDraftForEmail(email_id, type, { model });
      return { content: [{ type: "text", text: draft }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

server.tool(
  "delete_triage",
  "Delete a triage result",
  {
    triage_id: z.string().describe("Triage result ID"),
  },
  async ({ triage_id }) => {
    try {
      const deleted = deleteTriage(triage_id);
      return { content: [{ type: "text", text: deleted ? "Deleted" : "Not found" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
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

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  registerCloudTools(server, "emails");
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
