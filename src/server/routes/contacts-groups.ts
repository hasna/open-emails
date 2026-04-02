// API route handlers — contacts-groups.ts
import { listContacts, suppressContact, unsuppressContact } from '../../db/contacts.js';
import { listTemplates, createTemplate, deleteTemplate } from '../../db/templates.js';
import { listGroups, createGroup, deleteGroup, getGroupByName, listMembers, addMember, removeMember } from '../../db/groups.js';
import { listScheduledEmails, cancelScheduledEmail } from '../../db/scheduled.js';
import { getEmailContent } from '../../db/email-content.js';
import { getAnalytics } from '../../lib/analytics.js';
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from '../../lib/export.js';
import { runDiagnostics } from '../../lib/doctor.js';
import { syncAll, syncProvider } from '../../lib/sync.js';
import { json, notFound, badRequest, internalError, resolveId, parseBody } from './helpers.js';

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
// ─── CONTACTS ──────────────────────────────────────────────────────────

// GET /api/contacts?suppressed=true|false
if (path === "/api/contacts" && method === "GET") {
  try {
    const suppressedParam = url.searchParams.get("suppressed");
    const opts = suppressedParam !== null ? { suppressed: suppressedParam === "true" } : undefined;
    return json(listContacts(opts));
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/suppress
const contactSuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/suppress$/);
if (contactSuppressMatch && method === "POST") {
  try {
    suppressContact(decodeURIComponent(contactSuppressMatch[1]!));
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/unsuppress
const contactUnsuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/unsuppress$/);
if (contactUnsuppressMatch && method === "POST") {
  try {
    unsuppressContact(decodeURIComponent(contactUnsuppressMatch[1]!));
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── TEMPLATES ─────────────────────────────────────────────────────────

// GET /api/templates
if (path === "/api/templates" && method === "GET") {
  try {
    return json(listTemplates());
  } catch (e) { return internalError(e); }
}

// POST /api/templates
if (path === "/api/templates" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    if (!body.subject_template) return badRequest("subject_template is required");
    const template = createTemplate({
      name: String(body.name),
      subject_template: String(body.subject_template),
      html_template: body.html_template as string | undefined,
      text_template: body.text_template as string | undefined,
    });
    return json(template, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/templates/:id
const templateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
if (templateMatch && method === "DELETE") {
  try {
    const deleted = deleteTemplate(decodeURIComponent(templateMatch[1]!));
    if (!deleted) return notFound("Template not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── GROUPS ────────────────────────────────────────────────────────────

// GET /api/groups
if (path === "/api/groups" && method === "GET") {
  try {
    return json(listGroups());
  } catch (e) { return internalError(e); }
}

// POST /api/groups
if (path === "/api/groups" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    const group = createGroup(String(body.name), body.description as string | undefined);
    return json(group, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/groups/:id/members
const groupMembersMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
if (groupMembersMatch && method === "GET") {
  try {
    const group = getGroupByName(groupMembersMatch[1]!) ?? (() => {
      const id = resolveId("groups", groupMembersMatch[1]!);
      return id ? { id } as { id: string } : null;
    })();
    if (!group) return notFound("Group not found");
    return json(listMembers(group.id));
  } catch (e) { return internalError(e); }
}

// POST /api/groups/:id/members
if (groupMembersMatch && method === "POST") {
  try {
    const group = getGroupByName(groupMembersMatch[1]!) ?? (() => {
      const id = resolveId("groups", groupMembersMatch[1]!);
      return id ? { id } as { id: string } : null;
    })();
    if (!group) return notFound("Group not found");
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.email) return badRequest("email is required");
    const member = addMember(group.id, String(body.email), body.name as string | undefined);
    return json(member, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id/members/:email
const groupMemberDeleteMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
if (groupMemberDeleteMatch && method === "DELETE") {
  try {
    const group = getGroupByName(groupMemberDeleteMatch[1]!) ?? (() => {
      const id = resolveId("groups", groupMemberDeleteMatch[1]!);
      return id ? { id } as { id: string } : null;
    })();
    if (!group) return notFound("Group not found");
    const removed = removeMember(group.id, decodeURIComponent(groupMemberDeleteMatch[2]!));
    if (!removed) return notFound("Member not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id
const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
if (groupMatch && method === "DELETE") {
  try {
    const group = getGroupByName(groupMatch[1]!) ?? (() => {
      const id = resolveId("groups", groupMatch[1]!);
      return id ? { id } as { id: string } : null;
    })();
    if (!group) return notFound("Group not found");
    deleteGroup(group.id);
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── SCHEDULED ─────────────────────────────────────────────────────────

// GET /api/scheduled?status=pending|sent|cancelled
if (path === "/api/scheduled" && method === "GET") {
  try {
    const statusParam = url.searchParams.get("status") as "pending" | "sent" | "cancelled" | null;
    const opts = statusParam ? { status: statusParam } : undefined;
    return json(listScheduledEmails(opts));
  } catch (e) { return internalError(e); }
}

// DELETE /api/scheduled/:id
const scheduledMatch = path.match(/^\/api\/scheduled\/([^/]+)$/);
if (scheduledMatch && method === "DELETE") {
  const id = resolveId("scheduled_emails", scheduledMatch[1]!);
  if (!id) return notFound();
  try {
    const cancelled = cancelScheduledEmail(id);
    if (!cancelled) return badRequest("Cannot cancel email (may already be sent or cancelled)");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── ANALYTICS ─────────────────────────────────────────────────────────

// GET /api/analytics?provider_id=x&period=30d
if (path === "/api/analytics" && method === "GET") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const period = url.searchParams.get("period") ?? "30d";
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    return json(getAnalytics(resolvedId, period));
  } catch (e) { return internalError(e); }
}

// ─── EMAIL CONTENT ──────────────────────────────────────────────────────

// GET /api/email-content/:id
const emailContentMatch = path.match(/^\/api\/email-content\/([^/]+)$/);
if (emailContentMatch && method === "GET") {
  const id = resolveId("emails", emailContentMatch[1]!);
  if (!id) return notFound();
  try {
    const content = getEmailContent(id);
    if (!content) return notFound("Email content not found");
    return json(content);
  } catch (e) { return internalError(e); }
}

// ─── EXPORT ────────────────────────────────────────────────────────────

// GET /api/export/emails?format=csv|json&provider_id=x&since=...
if (path === "/api/export/emails" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    const filters = { provider_id: resolvedId, since };
    if (format === "csv") {
      return new Response(exportEmailsCsv(filters), {
        headers: { "Content-Type": "text/csv", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(exportEmailsJson(filters), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) { return internalError(e); }
}

// GET /api/export/events?format=csv|json&provider_id=x&since=...
if (path === "/api/export/events" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    const filters = { provider_id: resolvedId, since };
    if (format === "csv") {
      return new Response(exportEventsCsv(filters), {
        headers: { "Content-Type": "text/csv", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(exportEventsJson(filters), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) { return internalError(e); }
}

  return null;
}
