/**
 * Tests for the MCP inbox tools: sync_inbox, search_inbound, get_inbox_sync_status.
 *
 * Tests the underlying functions the MCP tool handlers invoke,
 * using a mock of @hasna/connect-gmail.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connect-gmail ────────────────────────────────────────────────

let mockMsgs: { id: string }[] = [];
let mockNextPageToken: string | undefined;
let mockGetImpl: ((id: string) => unknown) | null = null;

const mockGmail = {
  messages: {
    list: mock(async () => ({ messages: mockMsgs, nextPageToken: mockNextPageToken })),
    get: mock(async (id: string) => {
      if (mockGetImpl) return mockGetImpl(id);
      return {
        id,
        payload: { headers: [
          { name: "From", value: "a@x.com" },
          { name: "To", value: "me@x.com" },
          { name: "Subject", value: "Test Subject" },
          { name: "Date", value: "Fri, 20 Mar 2026 10:00:00 +0000" },
        ]},
        sizeEstimate: 200,
        __textBody: "Hello MCP",
        __htmlBody: "<p>Hello MCP</p>",
      };
    }),
    extractBody: mock((msg: Record<string, unknown>, preferHtml: boolean) =>
      (preferHtml ? msg["__htmlBody"] : msg["__textBody"]) as string ?? ""),
  },
  attachments: {
    list: mock(async () => []),
    downloadAll: mock(async () => []),
  },
};

mock.module("@hasna/connect-gmail", () => ({
  Gmail: {
    createWithTokens: mock(() => mockGmail),
    create: mock(() => mockGmail),
  },
}));

const { syncGmailInbox, syncGmailInboxAll } = await import("../lib/gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(
    `INSERT INTO providers (id, name, type, oauth_client_id, oauth_client_secret, oauth_refresh_token, active)
     VALUES (?, 'Gmail', 'gmail', 'cid', 'csec', 'rtoken', 1)`,
    [pid],
  );
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
      attachment_paths: [],
      headers: {},
      raw_size: 80,
      received_at: new Date().toISOString(),
    }, db);
  }
}

beforeEach(() => {
  mockMsgs = [];
  mockNextPageToken = undefined;
  mockGetImpl = null;
  mockGmail.messages.list.mockReset();
  mockGmail.messages.get.mockReset();
  mockGmail.attachments.list.mockReset();
  mockGmail.attachments.downloadAll.mockReset();

  mockGmail.messages.list.mockImplementation(async () => ({
    messages: mockMsgs, nextPageToken: mockNextPageToken,
  }));
  mockGmail.messages.get.mockImplementation(async (id: string) => {
    if (mockGetImpl) return mockGetImpl(id);
    return {
      id,
      payload: { headers: [
        { name: "From", value: "a@x.com" }, { name: "To", value: "me@x.com" },
        { name: "Subject", value: "Test Subject" }, { name: "Date", value: "Fri, 20 Mar 2026 10:00:00 +0000" },
      ]},
      sizeEstimate: 200, __textBody: "Hello MCP", __htmlBody: "<p>Hello MCP</p>",
    };
  });
  mockGmail.attachments.list.mockImplementation(async () => []);
  mockGmail.attachments.downloadAll.mockImplementation(async () => []);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

// ─── sync_inbox tool logic ────────────────────────────────────────────────────

describe("sync_inbox tool logic", () => {
  it("returns synced/skipped/errors/done in result", async () => {
    const { db, pid } = setupDb();
    mockMsgs = [{ id: "t1" }];
    const result = await syncGmailInbox({ providerId: pid, db });
    expect(typeof result.synced).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.done).toBe("boolean");
    expect(typeof result.attachments_saved).toBe("number");
  });

  it("synced=1 after syncing one message", async () => {
    const { db, pid } = setupDb();
    mockMsgs = [{ id: "t1" }];
    const result = await syncGmailInbox({ providerId: pid, db });
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("errors when list fails", async () => {
    const { db, pid } = setupDb();
    mockGmail.messages.list.mockImplementation(async () => { throw new Error("auth fail"); });
    const result = await syncGmailInbox({ providerId: pid, db });
    expect(result.synced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to list messages");
  });

  it("updateLastSynced sets last_synced_at after sync", async () => {
    const { db, pid } = setupDb();
    mockMsgs = [{ id: "t1" }];
    await syncGmailInbox({ providerId: pid, db });
    updateLastSynced(pid, undefined, db);
    const state = getGmailSyncState(pid, db);
    expect(state?.last_synced_at).toBeTruthy();
  });

  it("syncGmailInboxAll returns done=true on single page", async () => {
    const { db, pid } = setupDb();
    mockMsgs = [{ id: "t1" }];
    const result = await syncGmailInboxAll({ providerId: pid, db });
    expect(result.done).toBe(true);
    expect(result.synced).toBe(1);
  });

  it("respects batchSize (passed to messages.list)", async () => {
    const { db, pid } = setupDb();
    mockMsgs = [];
    await syncGmailInbox({ providerId: pid, batchSize: 5, db });
    const call = mockGmail.messages.list.mock.calls[0];
    expect(call?.[0]?.maxResults).toBe(5);
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
    const results = listInboundEmails({ provider_id: pid, limit: 100 }, db)
      .filter(e => e.from_address.toLowerCase().includes("from3@example.com"));
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
    const results = listInboundEmails({ provider_id: pid, limit: 40 }, db)
      .filter(e => e.subject.toLowerCase().includes("mcp"))
      .slice(0, 3);
    expect(results).toHaveLength(3);
  });
});

// ─── get_inbox_sync_status tool logic ────────────────────────────────────────

describe("get_inbox_sync_status tool logic", () => {
  it("returns null last_synced_at before any sync", () => {
    const { pid } = setupDb();
    const db = getDatabase();
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
});
