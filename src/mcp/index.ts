#!/usr/bin/env bun
/**
 * emails MCP server entry point.
 *
 * All tools are split into domain-specific modules in tools/.
 * This file just wires them together and starts the server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";

// Tool modules
import { registerTriageTools } from "./tools/triage.js";
import { registerWarmingTools } from "./tools/warming.js";
import { registerProviderTools } from "./tools/providers.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerSequenceTools } from "./tools/sequences.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerEmailOpsTools } from "./tools/email-ops.js";
import { registerMiscOpsTools } from "./tools/misc-ops.js";
import { registerInfrastructureTools } from "./tools/infrastructure.js";

// --- in-memory agent registry (used by infrastructure tools) ---
export interface EmailAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
export const emailAgents = new Map<string, EmailAgent>();

const server = new McpServer({
  name: "emails",
  version: "0.1.0",
});

async function main() {
  const transport = new StdioServerTransport();
  registerCloudTools(server, "emails");
  registerProviderTools(server);
  registerDomainTools(server);
  registerEmailOpsTools(server);
  registerMiscOpsTools(server);
  registerInboxTools(server);
  registerSequenceTools(server);
  registerWarmingTools(server);
  registerTriageTools(server);
  registerInfrastructureTools(server);
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
