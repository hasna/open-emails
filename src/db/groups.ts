import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  group_id: string;
  email: string;
  name: string | null;
  vars: Record<string, string>;
  added_at: string;
}

interface GroupMemberRow {
  group_id: string;
  email: string;
  name: string | null;
  vars: string;
  added_at: string;
}

function rowToMember(row: GroupMemberRow): GroupMember {
  return {
    ...row,
    vars: JSON.parse(row.vars || "{}") as Record<string, string>,
  };
}

export function createGroup(name: string, description?: string, db?: Database): Group {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, name, description || null, timestamp, timestamp],
  );

  return getGroup(id, d)!;
}

export function getGroup(id: string, db?: Database): Group | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM groups WHERE id = ?").get(id) as Group | null;
  return row;
}

export function getGroupByName(name: string, db?: Database): Group | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM groups WHERE name = ?").get(name) as Group | null;
  return row;
}

export function listGroups(db?: Database): Group[] {
  const d = db || getDatabase();
  return d.query("SELECT * FROM groups ORDER BY name ASC").all() as Group[];
}

export function deleteGroup(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM groups WHERE id = ?", [id]);
  return result.changes > 0;
}

export function addMember(groupId: string, email: string, name?: string, vars?: Record<string, string>, db?: Database): GroupMember {
  const d = db || getDatabase();
  const timestamp = now();

  d.run(
    `INSERT OR REPLACE INTO group_members (group_id, email, name, vars, added_at) VALUES (?, ?, ?, ?, ?)`,
    [groupId, email, name || null, JSON.stringify(vars || {}), timestamp],
  );

  const row = d.query("SELECT * FROM group_members WHERE group_id = ? AND email = ?").get(groupId, email) as GroupMemberRow;
  return rowToMember(row);
}

export function removeMember(groupId: string, email: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM group_members WHERE group_id = ? AND email = ?", [groupId, email]);
  return result.changes > 0;
}

export function listMembers(groupId: string, db?: Database): GroupMember[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM group_members WHERE group_id = ? ORDER BY email ASC").all(groupId) as GroupMemberRow[];
  return rows.map(rowToMember);
}

export function getMemberCount(groupId: string, db?: Database): number {
  const d = db || getDatabase();
  const row = d.query("SELECT COUNT(*) as count FROM group_members WHERE group_id = ?").get(groupId) as { count: number };
  return row.count;
}
