import { listEmails } from "../db/emails.js";
import { listEvents } from "../db/events.js";
import type { Database } from "../db/database.js";
import type { EventType } from "../types/index.js";

export function exportEmailsCsv(filters: {provider_id?: string; since?: string; until?: string}, db?: Database): string {
  const emails = listEmails(filters, db);
  const header = "id,from,to,subject,status,sent_at";
  const rows = emails.map(e =>
    [e.id, e.from_address, JSON.stringify(e.to_addresses), JSON.stringify(e.subject), e.status, e.sent_at].join(",")
  );
  return [header, ...rows].join("\n");
}

export function exportEmailsJson(filters: {provider_id?: string; since?: string; until?: string}, db?: Database): string {
  return JSON.stringify(listEmails(filters, db), null, 2);
}

export function exportEventsCsv(filters: {provider_id?: string; type?: EventType; since?: string}, db?: Database): string {
  const events = listEvents(filters, db);
  const header = "id,email_id,type,recipient,occurred_at";
  const rows = events.map(e => [e.id, e.email_id || "", e.type, e.recipient || "", e.occurred_at].join(","));
  return [header, ...rows].join("\n");
}

export function exportEventsJson(filters: {provider_id?: string; type?: EventType; since?: string}, db?: Database): string {
  return JSON.stringify(listEvents(filters, db), null, 2);
}
