import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { EmailEvent, EventFilter, EventRow, EventType } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function rowToEvent(row: EventRow): EmailEvent {
  return {
    ...row,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
    type: row.type as EventType,
  };
}

export interface CreateEventInput {
  email_id?: string | null;
  provider_id: string;
  provider_event_id?: string | null;
  type: EventType;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export function createEvent(input: CreateEventInput, db?: Database): EmailEvent {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO events (id, email_id, provider_id, provider_event_id, type, recipient, metadata, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.email_id || null,
      input.provider_id,
      input.provider_event_id || null,
      input.type,
      input.recipient || null,
      JSON.stringify(input.metadata || {}),
      input.occurred_at,
      timestamp,
    ],
  );

  const row = d.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow;
  return rowToEvent(row);
}

export function listEvents(filter: EventFilter = {}, db?: Database): EmailEvent[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.email_id) {
    conditions.push("email_id = ?");
    params.push(filter.email_id);
  }

  if (filter.provider_id) {
    conditions.push("provider_id = ?");
    params.push(filter.provider_id);
  }

  if (filter.type) {
    if (Array.isArray(filter.type)) {
      conditions.push(`type IN (${filter.type.map(() => "?").join(",")})`);
      params.push(...filter.type);
    } else {
      conditions.push("type = ?");
      params.push(filter.type);
    }
  }

  if (filter.since) {
    conditions.push("occurred_at >= ?");
    params.push(filter.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limitClause = "";
  if (filter.limit) {
    limitClause = " LIMIT ?";
    params.push(filter.limit);
    if (filter.offset) {
      limitClause += " OFFSET ?";
      params.push(filter.offset);
    }
  }

  const rows = d
    .query(`SELECT * FROM events ${where} ORDER BY occurred_at DESC${limitClause}`)
    .all(...params) as EventRow[];

  return rows.map(rowToEvent);
}

export function getEventsByEmail(email_id: string, db?: Database): EmailEvent[] {
  return listEvents({ email_id }, db);
}

export function upsertEvent(input: CreateEventInput, db?: Database): EmailEvent {
  const d = db || getDatabase();

  // If has a provider_event_id, check for existing to avoid dupes
  if (input.provider_event_id) {
    const existing = d.query(
      "SELECT * FROM events WHERE provider_id = ? AND provider_event_id = ?",
    ).get(input.provider_id, input.provider_event_id) as EventRow | null;

    if (existing) {
      return rowToEvent(existing);
    }
  }

  return createEvent(input, d);
}
