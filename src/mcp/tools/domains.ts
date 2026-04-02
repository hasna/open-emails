// MCP tool module: domains.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from '../../db/domains.js';
import { createAddress, listAddresses, deleteAddress, getAddress } from '../../db/addresses.js';
import { getAdapter } from '../../providers/index.js';
import { formatError, resolveId, DomainNotFoundError, AddressNotFoundError } from '../helpers.js';

export function registerDomainTools(server: McpServer): void {
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

}
