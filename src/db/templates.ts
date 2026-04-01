import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

export interface Template {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface TemplateRow {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: TemplateRow): Template {
  return {
    ...row,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
  };
}

export function createTemplate(
  input: {
    name: string;
    subject_template: string;
    html_template?: string;
    text_template?: string;
  },
  db?: Database,
): Template {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO templates (id, name, subject_template, html_template, text_template, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
    [
      id,
      input.name,
      input.subject_template,
      input.html_template || null,
      input.text_template || null,
      timestamp,
      timestamp,
    ],
  );

  return getTemplate(id, d)!;
}

export function getTemplate(nameOrId: string, db?: Database): Template | null {
  const d = db || getDatabase();
  // Try by ID first, then by name
  let row = d.query("SELECT * FROM templates WHERE id = ?").get(nameOrId) as TemplateRow | null;
  if (!row) {
    row = d.query("SELECT * FROM templates WHERE name = ?").get(nameOrId) as TemplateRow | null;
  }
  if (!row) return null;
  return rowToTemplate(row);
}

export function getTemplateByName(name: string, db?: Database): Template | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | null;
  if (!row) return null;
  return rowToTemplate(row);
}

export function listTemplates(db?: Database): Template[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM templates ORDER BY created_at DESC").all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function deleteTemplate(nameOrId: string, db?: Database): boolean {
  const d = db || getDatabase();
  // Try by ID first
  let result = d.run("DELETE FROM templates WHERE id = ?", [nameOrId]);
  if (result.changes > 0) return true;
  // Try by name
  result = d.run("DELETE FROM templates WHERE name = ?", [nameOrId]);
  return result.changes > 0;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}
