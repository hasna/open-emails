#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createProvider, listProviders, deleteProvider, getProvider, getActiveProvider, updateProvider } from "../db/providers.js";
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress, listAddresses, deleteAddress, getAddress } from "../db/addresses.js";
import { createEmail, listEmails, getEmail, searchEmails } from "../db/emails.js";
import { createTemplate, listTemplates, getTemplate, deleteTemplate, renderTemplate } from "../db/templates.js";
import { listContacts, suppressContact, unsuppressContact } from "../db/contacts.js";
import { createScheduledEmail, listScheduledEmails, cancelScheduledEmail } from "../db/scheduled.js";
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMembers, getMemberCount } from "../db/groups.js";
import { storeEmailContent, getEmailContent } from "../db/email-content.js";
import { listSandboxEmails, getSandboxEmail, clearSandboxEmails } from "../db/sandbox.js";
import { listInboundEmails, getInboundEmail, clearInboundEmails } from "../db/inbound.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "../lib/stats.js";
import { syncAll, syncProvider } from "../lib/sync.js";
import {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
} from "../types/index.js";

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

      const sendInput = { ...input, subject, html, text };
      const adapter = getAdapter(provider);
      const messageId = await adapter.sendEmail(sendInput);

      const email = createEmail(providerId, sendInput, messageId, db);

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

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
