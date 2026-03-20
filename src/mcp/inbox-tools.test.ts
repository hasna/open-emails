/**
 * Tests for the MCP inbox tools: sync_inbox, search_inbound, get_inbox_sync_status.
 *
 * Since MCP tool handlers are closures inside the server setup, we test
 * the exact same underlying functions they invoke — this gives us coverage
 * of the logic without requiring a running MCP transport.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (_n: string, _a: string[]) => ({
  success: true, stdout: "[]", stderr: "", exitCode: 0,
}));

mock.module("@hasna/connectors", () => ({ runConnectorCommand: mockRun }));

const { syncGmailInbox, syncGmailInboxAll } = await import("../lib/gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [pid]);
  return { db, pid };
}

function seed(providerId: string, n: number) {
  const db = getDatabase();
  for (let i = 0; i < n; i++) {
    storeInboundEmail({
      provider_id: providerId,
      message_id: `mcp-msg-${i}`,
      in_reply_to_email_id: null,
      from_address: `from${i}@example.com`,
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: `MCP Subject ${i}`,
      text_body: `MCP body text number ${i}`,
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 80,
      received_at: new Date().toISOString(),
    }, db);
  }
}

beforeEach(() => mockRun.mockReset());

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

// ─── sync_inbox tool logic ────────────────────────────────────────────────────

describe("sync_inbox tool logic", () => {
  const LIST = `[{"id":"t1","from":"a@x.com","subject":"S1","date":"Fri, 20 Mar 2026 10:00:00 +0000"}]`;
  const READ = `{"id":"t1","from":"a@x.com","to":"me@x.com","subject":"S1","date":"Fri, 20 Mar 2026 10:00:00 +0000","body":"Hello MCP"}`;

  function setupMock() {
    let readDone = false;
    mockRun.mockImplementation(async (_n: string, a: string[]) => {
      if (a.includes("read")) { readDone = true; return { success: true, stdout: READ, stderr: "", exitCode: 0 }; }
      return { success: true, stdout: LIST, stderr: "", exitCode: 0 };
    });
  }

  it("returns synced/skipped/errors/done in result", async () => {
    const { db, pid } = setupDb();
    setupMock();
    const result = await syncGmailInbox({ providerId: pid, db });
    // Validate the shape the MCP tool would return
    expect(typeof result.synced).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.done).toBe("boolean");
  });

  it("synced=1 after syncing one message", async () => {
    const { db, pid } = setupDb();
    setupMock();
    const result = await syncGmailInbox({ providerId: pid, db });
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("errors array is populated on list failure", async () => {
    const { db, pid } = setupDb();
    mockRun.mockImplementation(async () => ({ success: false, stdout: "", stderr: "auth fail", exitCode: 1 }));
    const result = await syncGmailInbox({ providerId: pid, db });
    expect(result.synced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to list");
  });

  it("updateLastSynced sets last_synced_at after sync", async () => {
    const { db, pid } = setupDb();
    setupMock();
    await syncGmailInbox({ providerId: pid, db });
    updateLastSynced(pid, undefined, db);
    const state = getGmailSyncState(pid, db);
    expect(state).not.toBeNull();
    expect(state!.last_synced_at).toBeTruthy();
  });

  it("syncGmailInboxAll (all_pages=true) returns done=true on single page", async () => {
    const { db, pid } = setupDb();
    setupMock();
    const result = await syncGmailInboxAll({ providerId: pid, db });
    expect(result.done).toBe(true);
    expect(result.synced).toBe(1);
  });

  it("respects limit param (batchSize)", async () => {
    const { db, pid } = setupDb();
    setupMock();
    await syncGmailInbox({ providerId: pid, batchSize: 5, db });
    const listCall = mockRun.mock.calls.find(c => c[1]?.includes("list"));
    const maxIdx = listCall![1].indexOf("--max");
    expect(listCall![1][maxIdx + 1]).toBe("5");
  });
});

// ─── search_inbound tool logic ────────────────────────────────────────────────

describe("search_inbound tool logic", () => {
  it("returns emails matching subject query", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const q = "subject 2";
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => e.subject.toLowerCase().includes(q) ||
        e.from_address.toLowerCase().includes(q) ||
        (e.text_body ?? "").toLowerCase().includes(q))
      .slice(0, 20);
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toContain("2");
  });

  it("returns emails matching from_address query", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const q = "from3@example.com";
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => e.from_address.toLowerCase().includes(q));
    expect(results).toHaveLength(1);
  });

  it("returns emails matching body text", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const q = "body text number 4";
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => (e.text_body ?? "").toLowerCase().includes(q));
    expect(results).toHaveLength(1);
  });

  it("returns empty array for no match", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const q = "zzz-impossible-match-zzz";
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => e.subject.toLowerCase().includes(q) ||
        e.from_address.toLowerCase().includes(q) ||
        (e.text_body ?? "").toLowerCase().includes(q));
    expect(results).toHaveLength(0);
  });

  it("respects limit in slicing results", () => {
    const { pid } = setupDb();
    seed(pid, 10);
    const db = getDatabase();
    // Search for "mcp" which matches all 10
    const q = "mcp";
    const results = listInboundEmails({ provider_id: pid, limit: 40 }, db)
      .filter(e => e.subject.toLowerCase().includes(q) || (e.text_body ?? "").toLowerCase().includes(q))
      .slice(0, 3); // limit=3
    expect(results).toHaveLength(3);
  });

  it("filters by provider_id when provided", () => {
    const { db, pid } = setupDb();
    seed(pid, 3);

    const otherId = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Other', 'gmail', 1)`, [otherId]);
    storeInboundEmail({
      provider_id: otherId, message_id: "o1", in_reply_to_email_id: null,
      from_address: "other@x.com", to_addresses: [], cc_addresses: [],
      subject: "Other", text_body: "other body", html_body: null,
      attachments: [], headers: {}, raw_size: 10, received_at: new Date().toISOString(),
    }, db);

    const q = "mcp";
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => e.subject.toLowerCase().includes(q) || (e.text_body ?? "").toLowerCase().includes(q));
    expect(results.every(e => e.provider_id === pid)).toBe(true);
    expect(results).toHaveLength(3);
  });
});

// ─── get_inbox_sync_status tool logic ────────────────────────────────────────

describe("get_inbox_sync_status tool logic", () => {
  it("returns null last_synced_at before any sync", () => {
    const { pid } = setupDb();
    const db = getDatabase();
    const providers = db.query("SELECT * FROM providers WHERE type = 'gmail'").all() as { id: string; name: string }[];
    expect(providers).toHaveLength(1);

    const state = getGmailSyncState(pid, db);
    expect(state?.last_synced_at ?? null).toBeNull();
  });

  it("reflects synced count after seeding", () => {
    const { pid } = setupDb();
    seed(pid, 4);
    const db = getDatabase();
    const row = db.query("SELECT COUNT(*) as c FROM inbound_emails WHERE provider_id = ?").get(pid) as { c: number };
    expect(row.c).toBe(4);
  });

  it("reflects last_synced_at after updateLastSynced", () => {
    const { db, pid } = setupDb();
    updateLastSynced(pid, "last-id", db);
    const state = getGmailSyncState(pid, db);
    expect(state!.last_synced_at).toBeTruthy();
    expect(state!.last_message_id).toBe("last-id");
  });

  it("returns status for multiple providers", () => {
    const { db, pid } = setupDb();
    const pid2 = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail2', 'gmail', 1)`, [pid2]);

    seed(pid, 2);
    updateLastSynced(pid, undefined, db);

    const providers = db.query("SELECT * FROM providers WHERE type = 'gmail'").all() as { id: string; name: string }[];
    expect(providers).toHaveLength(2);

    const states = providers.map(p => {
      const state = getGmailSyncState(p.id, db);
      const count = (db.query("SELECT COUNT(*) as c FROM inbound_emails WHERE provider_id = ?").get(p.id) as { c: number }).c;
      return { provider_id: p.id, last_synced_at: state?.last_synced_at ?? null, synced_count: count };
    });

    const p1Status = states.find(s => s.provider_id === pid);
    const p2Status = states.find(s => s.provider_id === pid2);

    expect(p1Status!.synced_count).toBe(2);
    expect(p1Status!.last_synced_at).toBeTruthy();
    expect(p2Status!.synced_count).toBe(0);
    expect(p2Status!.last_synced_at).toBeNull();
  });
});
