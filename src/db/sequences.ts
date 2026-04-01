import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

export type SequenceStatus = "active" | "paused" | "archived";
export type EnrollmentStatus = "active" | "completed" | "cancelled";

export interface Sequence {
  id: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  template_name: string;
  from_address: string | null;
  subject_override: string | null;
  created_at: string;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_email: string;
  provider_id: string | null;
  current_step: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  next_send_at: string | null;
  completed_at: string | null;
}

interface SequenceRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface EnrollmentRow {
  id: string;
  sequence_id: string;
  contact_email: string;
  provider_id: string | null;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_send_at: string | null;
  completed_at: string | null;
}

function rowToSequence(row: SequenceRow): Sequence {
  return { ...row, status: row.status as SequenceStatus };
}

function rowToEnrollment(row: EnrollmentRow): SequenceEnrollment {
  return { ...row, status: row.status as EnrollmentStatus };
}

// ─── SEQUENCES ────────────────────────────────────────────────────────────────

export function createSequence(
  input: { name: string; description?: string },
  db?: Database,
): Sequence {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO sequences (id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [id, input.name, input.description || null, timestamp, timestamp],
  );

  return getSequence(id, d)!;
}

export function getSequence(nameOrId: string, db?: Database): Sequence | null {
  const d = db || getDatabase();
  let row = d.query("SELECT * FROM sequences WHERE id = ?").get(nameOrId) as SequenceRow | null;
  if (!row) {
    row = d.query("SELECT * FROM sequences WHERE name = ?").get(nameOrId) as SequenceRow | null;
  }
  if (!row) return null;
  return rowToSequence(row);
}

export function listSequences(db?: Database): Sequence[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM sequences ORDER BY created_at DESC").all() as SequenceRow[];
  return rows.map(rowToSequence);
}

export function updateSequence(
  id: string,
  updates: Partial<Pick<Sequence, "name" | "description" | "status">>,
  db?: Database,
): Sequence {
  const d = db || getDatabase();
  const seq = d.query("SELECT * FROM sequences WHERE id = ?").get(id) as SequenceRow | null;
  if (!seq) throw new Error(`Sequence not found: ${id}`);

  const name = updates.name ?? seq.name;
  const description = updates.description !== undefined ? updates.description : seq.description;
  const status = updates.status ?? seq.status;
  const timestamp = now();

  d.run(
    "UPDATE sequences SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
    [name, description, status, timestamp, id],
  );

  return getSequence(id, d)!;
}

export function deleteSequence(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM sequences WHERE id = ?", [id]);
  return result.changes > 0;
}

// ─── STEPS ────────────────────────────────────────────────────────────────────

export function addStep(
  input: {
    sequence_id: string;
    step_number: number;
    delay_hours: number;
    template_name: string;
    from_address?: string;
    subject_override?: string;
  },
  db?: Database,
): SequenceStep {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO sequence_steps (id, sequence_id, step_number, delay_hours, template_name, from_address, subject_override, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sequence_id,
      input.step_number,
      input.delay_hours,
      input.template_name,
      input.from_address || null,
      input.subject_override || null,
      timestamp,
    ],
  );

  return d.query("SELECT * FROM sequence_steps WHERE id = ?").get(id) as SequenceStep;
}

export function listSteps(sequence_id: string, db?: Database): SequenceStep[] {
  const d = db || getDatabase();
  return d
    .query("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_number ASC")
    .all(sequence_id) as SequenceStep[];
}

export function removeStep(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM sequence_steps WHERE id = ?", [id]);
  return result.changes > 0;
}

// ─── ENROLLMENTS ──────────────────────────────────────────────────────────────

export function enroll(
  input: { sequence_id: string; contact_email: string; provider_id?: string },
  db?: Database,
): SequenceEnrollment {
  const d = db || getDatabase();

  // Idempotent: return existing active enrollment if already enrolled
  const existing = d
    .query("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND contact_email = ?")
    .get(input.sequence_id, input.contact_email) as EnrollmentRow | null;

  if (existing) return rowToEnrollment(existing);

  const id = uuid();
  const timestamp = now();

  // Compute next_send_at based on first step's delay_hours
  const firstStep = d
    .query("SELECT delay_hours FROM sequence_steps WHERE sequence_id = ? ORDER BY step_number ASC LIMIT 1")
    .get(input.sequence_id) as { delay_hours: number } | null;

  const nextSendAt = firstStep
    ? new Date(Date.now() + firstStep.delay_hours * 3600 * 1000).toISOString()
    : null;

  d.run(
    `INSERT INTO sequence_enrollments (id, sequence_id, contact_email, provider_id, current_step, status, enrolled_at, next_send_at, completed_at)
     VALUES (?, ?, ?, ?, 0, 'active', ?, ?, NULL)`,
    [id, input.sequence_id, input.contact_email, input.provider_id || null, timestamp, nextSendAt],
  );

  return d
    .query("SELECT * FROM sequence_enrollments WHERE id = ?")
    .get(id) as SequenceEnrollment;
}

export function unenroll(sequence_id: string, contact_email: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run(
    "UPDATE sequence_enrollments SET status = 'cancelled' WHERE sequence_id = ? AND contact_email = ? AND status = 'active'",
    [sequence_id, contact_email],
  );
  return result.changes > 0;
}

export function listEnrollments(
  opts?: { sequence_id?: string; status?: string },
  db?: Database,
): SequenceEnrollment[] {
  const d = db || getDatabase();

  if (opts?.sequence_id && opts?.status) {
    return d
      .query("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND status = ? ORDER BY enrolled_at DESC")
      .all(opts.sequence_id, opts.status) as SequenceEnrollment[];
  }
  if (opts?.sequence_id) {
    return d
      .query("SELECT * FROM sequence_enrollments WHERE sequence_id = ? ORDER BY enrolled_at DESC")
      .all(opts.sequence_id) as SequenceEnrollment[];
  }
  if (opts?.status) {
    return d
      .query("SELECT * FROM sequence_enrollments WHERE status = ? ORDER BY enrolled_at DESC")
      .all(opts.status) as SequenceEnrollment[];
  }
  return d
    .query("SELECT * FROM sequence_enrollments ORDER BY enrolled_at DESC")
    .all() as SequenceEnrollment[];
}

export function getDueEnrollments(db?: Database): SequenceEnrollment[] {
  const d = db || getDatabase();
  const currentTime = now();
  return d
    .query(
      "SELECT * FROM sequence_enrollments WHERE status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC",
    )
    .all(currentTime) as SequenceEnrollment[];
}

export function advanceEnrollment(enrollment_id: string, db?: Database): SequenceEnrollment | null {
  const d = db || getDatabase();
  const enrollment = d
    .query("SELECT * FROM sequence_enrollments WHERE id = ?")
    .get(enrollment_id) as EnrollmentRow | null;

  if (!enrollment) return null;

  // current_step is a 0-based index into the sorted steps array.
  // After sending the step at index current_step, advance to current_step+1.
  const nextIndex = enrollment.current_step + 1;

  // Get all steps sorted by step_number and find the one at nextIndex
  const allSteps = d
    .query("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_number ASC")
    .all(enrollment.sequence_id) as SequenceStep[];

  const nextStep = allSteps[nextIndex] ?? null;

  if (!nextStep) {
    // No more steps — mark as completed
    const completedAt = now();
    d.run(
      "UPDATE sequence_enrollments SET status = 'completed', completed_at = ?, next_send_at = NULL, current_step = ? WHERE id = ?",
      [completedAt, nextIndex, enrollment_id],
    );
  } else {
    // Advance to next step
    const nextSendAt = new Date(Date.now() + nextStep.delay_hours * 3600 * 1000).toISOString();
    d.run(
      "UPDATE sequence_enrollments SET current_step = ?, next_send_at = ? WHERE id = ?",
      [nextIndex, nextSendAt, enrollment_id],
    );
  }

  const row = d
    .query("SELECT * FROM sequence_enrollments WHERE id = ?")
    .get(enrollment_id) as EnrollmentRow | null;
  return row ? rowToEnrollment(row) : null;
}
