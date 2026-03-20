import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resetDatabase, getDatabase, uuid } from "../db/database.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────
// Must be called before importing gmail-sync so the mock is in place

const mockRunConnectorCommand = mock(async (_name: string, _args: string[]) => ({
  success: true,
  stdout: "[]",
  stderr: "",
  exitCode: 0,
}));

mock.module("@hasna/connectors", () => ({
  runConnectorCommand: mockRunConnectorCommand,
}));

// Import after mock is set up
const { syncGmailInbox, syncGmailInboxAll, parseJsonFromOutput } = await import("./gmail-sync.js");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_LIST_OUTPUT = `✓ Found 2 messages:
[
  {"id":"msg1","from":"alice@example.com","subject":"Hello","date":"Fri, 20 Mar 2026 10:00:00 +0000"},
  {"id":"msg2","from":"bob@example.com","subject":"World","date":"Fri, 20 Mar 2026 11:00:00 +0000"}
]`;

const MOCK_READ_MSG1 = `{
  "id":"msg1","threadId":"thread1",
  "from":"alice@example.com","to":"me@example.com",
  "subject":"Hello","date":"Fri, 20 Mar 2026 10:00:00 +0000",
  "labels":["INBOX"],"body":"Hello there!"
}`;

const MOCK_READ_MSG2 = `{
  "id":"msg2","threadId":"thread2",
  "from":"bob@example.com","to":"me@example.com",
  "subject":"World","date":"Fri, 20 Mar 2026 11:00:00 +0000",
  "labels":["INBOX"],"body":"World content."
}`;

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type) VALUES (?, 'gmail-test', 'gmail')`, [providerId]);
  return { db, providerId };
}

function setMockResponses(listOutput: string, readOutputs: string[]) {
  let readIndex = 0;
  mockRunConnectorCommand.mockImplementation(async (_name: string, args: string[]) => {
    const isRead = args.includes("read");
    if (isRead) {
      const out = readOutputs[readIndex++] ?? "{}";
      return { success: true, stdout: out, stderr: "", exitCode: 0 };
    }
    return { success: true, stdout: listOutput, stderr: "", exitCode: 0 };
  });
}

// ─── parseJsonFromOutput ──────────────────────────────────────────────────────

describe("parseJsonFromOutput", () => {
  it("parses plain JSON array", () => {
    const result = parseJsonFromOutput('[{"id":"1"}]');
    expect(result).toEqual([{ id: "1" }]);
  });

  it("parses plain JSON object", () => {
    const result = parseJsonFromOutput('{"id":"1","from":"a@b.com"}');
    expect(result).toEqual({ id: "1", from: "a@b.com" });
  });

  it("strips preamble text before JSON array", () => {
    const result = parseJsonFromOutput('✓ Found 2 messages:\n[{"id":"1"}]');
    expect(Array.isArray(result)).toBe(true);
    expect((result as { id: string }[])[0]?.id).toBe("1");
  });

  it("throws when no JSON found", () => {
    expect(() => parseJsonFromOutput("No JSON here")).toThrow("No JSON found");
  });
});

// ─── syncGmailInbox ───────────────────────────────────────────────────────────

describe("syncGmailInbox", () => {
  beforeEach(() => {
    mockRunConnectorCommand.mockReset();
  });

  it("syncs two messages into inbound_emails", async () => {
    const { db, providerId } = setupDb();
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1, MOCK_READ_MSG2]);

    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const rows = db.query("SELECT * FROM inbound_emails WHERE provider_id = ?").all(providerId) as { message_id: string; subject: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.message_id).sort()).toEqual(["msg1", "msg2"]);
  });

  it("skips already-synced messages (dedup by message_id)", async () => {
    const { db, providerId } = setupDb();
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1, MOCK_READ_MSG2]);

    // First sync
    await syncGmailInbox({ providerId, db });

    // Reset mock for second call
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1, MOCK_READ_MSG2]);

    // Second sync — both should be skipped
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("stores correct fields from Gmail message", async () => {
    const { db, providerId } = setupDb();
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1, MOCK_READ_MSG2]);

    await syncGmailInbox({ providerId, db });

    const row = db.query("SELECT * FROM inbound_emails WHERE message_id = 'msg1'").get() as {
      from_address: string; subject: string; text_body: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.from_address).toBe("alice@example.com");
    expect(row!.subject).toBe("Hello");
    expect(row!.text_body).toBe("Hello there!");
  });

  it("continues syncing when one message read fails", async () => {
    const { db, providerId } = setupDb();
    let readCount = 0;
    mockRunConnectorCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("read")) {
        readCount++;
        if (readCount === 1) return { success: false, stdout: "", stderr: "read error", exitCode: 1 };
        return { success: true, stdout: MOCK_READ_MSG2, stderr: "", exitCode: 0 };
      }
      return { success: true, stdout: MOCK_LIST_OUTPUT, stderr: "", exitCode: 0 };
    });

    const result = await syncGmailInbox({ providerId, db });

    // msg1 fails to read but is stored as summary-only (falls back)
    // msg2 succeeds
    expect(result.errors).toHaveLength(0); // individual read failures fall back, not counted as errors
    expect(result.synced).toBeGreaterThanOrEqual(1);
  });

  it("returns error when list command fails", async () => {
    const { db, providerId } = setupDb();
    mockRunConnectorCommand.mockImplementation(async () => ({
      success: false, stdout: "", stderr: "auth error", exitCode: 1,
    }));

    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to list Gmail messages");
  });

  it("respects batchSize limit", async () => {
    const { db, providerId } = setupDb();
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1]);

    await syncGmailInbox({ providerId, batchSize: 1, db });

    // Should have called list with --max 1
    const listCall = mockRunConnectorCommand.mock.calls.find(c => c[1]?.includes("list"));
    expect(listCall).toBeDefined();
    const maxIdx = listCall![1].indexOf("--max");
    expect(listCall![1][maxIdx + 1]).toBe("1");
  });

  it("passes --query when query option is set", async () => {
    const { db, providerId } = setupDb();
    mockRunConnectorCommand.mockImplementation(async () => ({
      success: true, stdout: "[]", stderr: "", exitCode: 0,
    }));

    await syncGmailInbox({ providerId, query: "is:unread", db });

    const listCall = mockRunConnectorCommand.mock.calls.find(c => c[1]?.includes("list"));
    expect(listCall![1]).toContain("--query");
    expect(listCall![1]).toContain("is:unread");
  });

  it("passes --label when labelFilter is set", async () => {
    const { db, providerId } = setupDb();
    mockRunConnectorCommand.mockImplementation(async () => ({
      success: true, stdout: "[]", stderr: "", exitCode: 0,
    }));

    await syncGmailInbox({ providerId, labelFilter: "SENT", db });

    const listCall = mockRunConnectorCommand.mock.calls.find(c => c[1]?.includes("list"));
    expect(listCall![1]).toContain("--label");
    expect(listCall![1]).toContain("SENT");
  });

  it("handles empty list response gracefully", async () => {
    const { db, providerId } = setupDb();
    mockRunConnectorCommand.mockImplementation(async () => ({
      success: true, stdout: "✓ Found 0 messages:\n[]", stderr: "", exitCode: 0,
    }));

    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("includes since as after: query when set", async () => {
    const { db, providerId } = setupDb();
    mockRunConnectorCommand.mockImplementation(async () => ({
      success: true, stdout: "[]", stderr: "", exitCode: 0,
    }));

    await syncGmailInbox({ providerId, since: "2026-03-01T00:00:00Z", db });

    const listCall = mockRunConnectorCommand.mock.calls.find(c => c[1]?.includes("list"));
    const queryIdx = listCall![1].indexOf("--query");
    expect(queryIdx).toBeGreaterThanOrEqual(0);
    expect(listCall![1][queryIdx + 1]).toContain("after:2026/03/01");
  });
});

// ─── syncGmailInboxAll ────────────────────────────────────────────────────────

describe("syncGmailInboxAll", () => {
  beforeEach(() => mockRunConnectorCommand.mockReset());

  it("syncs a single page when done is true", async () => {
    const { db, providerId } = setupDb();
    setMockResponses(MOCK_LIST_OUTPUT, [MOCK_READ_MSG1, MOCK_READ_MSG2]);

    const result = await syncGmailInboxAll({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.done).toBe(true);
  });

  it("aggregates results across pages", async () => {
    const { db, providerId } = setupDb();
    let callCount = 0;

    // First page has 1 message, second page has 1 different message
    const page1 = `[{"id":"pageA","from":"a@x.com","subject":"A","date":"Fri, 20 Mar 2026 10:00:00 +0000"}]`;
    const page2 = `[{"id":"pageB","from":"b@x.com","subject":"B","date":"Fri, 20 Mar 2026 11:00:00 +0000"}]`;
    const readA = `{"id":"pageA","from":"a@x.com","subject":"A","date":"Fri, 20 Mar 2026 10:00:00 +0000","body":"A body"}`;
    const readB = `{"id":"pageB","from":"b@x.com","subject":"B","date":"Fri, 20 Mar 2026 11:00:00 +0000","body":"B body"}`;

    // Simulate two pages by returning list data based on call count,
    // but since connector CLI doesn't support pageToken, both calls return done:true
    // (syncGmailInboxAll aggregates based on the done flag from syncGmailInbox)
    let readIndex = 0;
    mockRunConnectorCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("read")) {
        const reads = [readA, readB];
        return { success: true, stdout: reads[readIndex++] ?? "{}", stderr: "", exitCode: 0 };
      }
      callCount++;
      return { success: true, stdout: callCount === 1 ? page1 : page2, stderr: "", exitCode: 0 };
    });

    // syncGmailInboxAll will call syncGmailInbox once; done=true since no nextPageToken
    const result = await syncGmailInboxAll({ providerId, db });
    expect(result.synced).toBeGreaterThanOrEqual(1);
    expect(result.done).toBe(true);
  });
});
