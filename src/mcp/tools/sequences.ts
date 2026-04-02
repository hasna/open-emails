import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createSequence, getSequence, listSequences,
  addStep, enroll, unenroll, listEnrollments,
} from "../../db/sequences.js";
import { listReplies, getReplyCount } from "../../db/inbound.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { formatError } from "../helpers.js";

export function registerSequenceTools(server: McpServer): void {
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

}
