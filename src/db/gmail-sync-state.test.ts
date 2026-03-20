import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "./database.js";
import {
  getGmailSyncState,
  setGmailSyncState,
  updateLastSynced,
  clearGmailSyncState,
} from "./gmail-sync-state.js";

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

beforeEach(() => {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("getGmailSyncState", () => {
  it("returns null for unknown provider", () => {
    setupDb();
    const state = getGmailSyncState("nonexistent-id");
    expect(state).toBeNull();
  });

  it("returns null before any state is set", () => {
    const { providerId } = setupDb();
    expect(getGmailSyncState(providerId)).toBeNull();
  });
});

describe("setGmailSyncState", () => {
  it("creates new state record", () => {
    const { db, providerId } = setupDb();
    const state = setGmailSyncState(providerId, { last_synced_at: "2026-03-20T10:00:00.000Z" }, db);
    expect(state.provider_id).toBe(providerId);
    expect(state.last_synced_at).toBe("2026-03-20T10:00:00.000Z");
    expect(state.updated_at).toBeTruthy();
  });

  it("updates existing state without overwriting null fields", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { last_message_id: "msg-abc", last_synced_at: "2026-03-01T00:00:00.000Z" }, db);
    setGmailSyncState(providerId, { history_id: "99999" }, db);

    const state = getGmailSyncState(providerId, db);
    expect(state!.last_message_id).toBe("msg-abc"); // preserved
    expect(state!.history_id).toBe("99999");        // updated
  });

  it("sets next_page_token", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "tok-xyz" }, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.next_page_token).toBe("tok-xyz");
  });

  it("overwrites next_page_token with null", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "tok-xyz" }, db);
    setGmailSyncState(providerId, { next_page_token: null }, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.next_page_token).toBeNull();
  });

  it("sets all fields at once", () => {
    const { db, providerId } = setupDb();
    const input = {
      last_synced_at: "2026-03-20T12:00:00.000Z",
      last_message_id: "msg-full",
      history_id: "55555",
      next_page_token: "page-tok",
    };
    const state = setGmailSyncState(providerId, input, db);
    expect(state.last_synced_at).toBe(input.last_synced_at);
    expect(state.last_message_id).toBe(input.last_message_id);
    expect(state.history_id).toBe(input.history_id);
    expect(state.next_page_token).toBe(input.next_page_token);
  });

  it("is idempotent — multiple sets converge correctly", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { last_message_id: "first" }, db);
    setGmailSyncState(providerId, { last_message_id: "second" }, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.last_message_id).toBe("second");
  });
});

describe("updateLastSynced", () => {
  it("sets last_synced_at to current time", () => {
    const { db, providerId } = setupDb();
    const before = Date.now();
    const state = updateLastSynced(providerId, undefined, db);
    const after = Date.now();
    const synced = new Date(state.last_synced_at!).getTime();
    expect(synced).toBeGreaterThanOrEqual(before);
    expect(synced).toBeLessThanOrEqual(after);
  });

  it("sets last_message_id when provided", () => {
    const { db, providerId } = setupDb();
    const state = updateLastSynced(providerId, "last-msg-id", db);
    expect(state.last_message_id).toBe("last-msg-id");
  });

  it("clears next_page_token", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "stale-token" }, db);
    updateLastSynced(providerId, undefined, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.next_page_token).toBeNull();
  });

  it("preserves history_id across updateLastSynced", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { history_id: "h-42" }, db);
    updateLastSynced(providerId, "m-1", db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.history_id).toBe("h-42");
  });

  it("creates state if it doesn't exist yet", () => {
    const { db, providerId } = setupDb();
    expect(getGmailSyncState(providerId, db)).toBeNull();
    updateLastSynced(providerId, undefined, db);
    expect(getGmailSyncState(providerId, db)).not.toBeNull();
  });
});

describe("clearGmailSyncState", () => {
  it("deletes existing state and returns true", () => {
    const { db, providerId } = setupDb();
    updateLastSynced(providerId, undefined, db);
    const deleted = clearGmailSyncState(providerId, db);
    expect(deleted).toBe(true);
    expect(getGmailSyncState(providerId, db)).toBeNull();
  });

  it("returns false for unknown provider", () => {
    setupDb();
    const deleted = clearGmailSyncState("nonexistent");
    expect(deleted).toBe(false);
  });
});
