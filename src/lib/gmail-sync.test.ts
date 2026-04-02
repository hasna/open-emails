import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetDatabase, closeDatabase, getDatabase, uuid } from "../db/database.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (_name: string, _args: string[]) => ({
  success: true, stdout: "[]", stderr: "", exitCode: 0,
}));

mock.module("@hasna/connectors", () => ({ runConnectorCommand: mockRun }));

const { syncGmailInbox, syncGmailInboxAll, parseJsonFromOutput } = await import("./gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";

function makeListOutput(msgs: { id: string; from?: string; subject?: string }[]): string {
  return JSON.stringify(msgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE })));
}

function makeReadOutput(m: { id: string; from?: string; to?: string; subject?: string; body?: string; htmlBody?: string }): string {
  return JSON.stringify({
    id: m.id,
    from: m.from ?? "a@b.com",
    to: m.to ?? "me@b.com",
    subject: m.subject ?? "S",
    date: DATE,
    body: m.body ?? "text body",
    htmlBody: m.htmlBody ?? "<p>html body</p>",
    size: 200,
  });
}

function setupDb() {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

function setMock(
  msgs: { id: string; from?: string; subject?: string; body?: string; htmlBody?: string }[],
  readOutputs?: string[],
) {
  let readIdx = 0;
  mockRun.mockImplementation(async (_name: string, args: string[]) => {
    if (args.includes("read") || args.includes("get")) {
      const isHtml = args.includes("--html");
      const idx = Math.max(args.indexOf("read"), args.indexOf("get"));
      const id = args[idx + 1] ?? "x";
      const msg = msgs.find((m) => m.id === id);
      if (readOutputs && !isHtml) {
        return { success: true, stdout: readOutputs[readIdx++] ?? makeReadOutput({ id }), stderr: "", exitCode: 0 };
      }
      if (isHtml && msg?.htmlBody) {
        // Return HTML body for --html calls
        return { success: true, stdout: JSON.stringify({ id, from: msg.from ?? "a@b.com", subject: msg.subject ?? "S", date: DATE, body: msg.htmlBody, size: 200 }), stderr: "", exitCode: 0 };
      }
      // Return text body
      return { success: true, stdout: makeReadOutput({ id, from: msg?.from, subject: msg?.subject, body: msg?.body }), stderr: "", exitCode: 0 };
    }
    if (args.includes("list")) {
      return { success: true, stdout: makeListOutput(msgs), stderr: "", exitCode: 0 };
    }
    // attachments list/download — return empty
    return { success: true, stdout: "[]", stderr: "", exitCode: 0 };
  });
}

beforeEach(() => mockRun.mockReset());
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

// ─── parseJsonFromOutput ──────────────────────────────────────────────────────

describe("parseJsonFromOutput", () => {
  it("parses plain JSON array", () => {
    expect(parseJsonFromOutput('[{"id":"1"}]')).toEqual([{ id: "1" }]);
  });
  it("parses plain JSON object", () => {
    expect(parseJsonFromOutput('{"id":"1"}')).toEqual({ id: "1" });
  });
  it("strips preamble text", () => {
    const r = parseJsonFromOutput('✓ Found:\n[{"id":"1"}]');
    expect(Array.isArray(r)).toBe(true);
  });
  it("throws when no JSON", () => {
    expect(() => parseJsonFromOutput("No JSON here")).toThrow("No JSON found");
  });
});

// ─── syncGmailInbox ───────────────────────────────────────────────────────────

describe("syncGmailInbox", () => {
  it("syncs two messages", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", from: "alice@example.com", subject: "Hello" }, { id: "msg2", from: "bob@example.com", subject: "World" }]);
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.errors).toHaveLength(0);
    const rows = db.query("SELECT message_id FROM inbound_emails WHERE provider_id = ?").all(providerId) as { message_id: string }[];
    expect(rows.map((r) => r.message_id).sort()).toEqual(["msg1", "msg2"]);
  });

  it("deduplicates on re-run", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1" }]);
    await syncGmailInbox({ providerId, db });
    setMock([{ id: "msg1" }]);
    const r2 = await syncGmailInbox({ providerId, db });
    expect(r2.synced).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("stores text and html body separately", async () => {
    const { db, providerId } = setupDb();
    // Provide both text body and HTML body — mock returns them for separate calls
    setMock([{ id: "msg1", body: "plain text", htmlBody: "<b>html</b>" }]);
    await syncGmailInbox({ providerId, db });
    const row = db.query("SELECT text_body, html_body FROM inbound_emails WHERE message_id = 'msg1'").get() as { text_body: string; html_body: string } | null;
    expect(row!.text_body).toBe("plain text");
    expect(row!.html_body).toBe("<b>html</b>");
  });

  it("returns error when list fails", async () => {
    const { db, providerId } = setupDb();
    mockRun.mockImplementation(async () => ({ success: false, stdout: "", stderr: "auth error", exitCode: 1 }));
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors[0]).toContain("Failed to list messages");
  });

  it("isolates per-message errors", async () => {
    const { db, providerId } = setupDb();
    let readCount = 0;
    mockRun.mockImplementation(async (_n: string, args: string[]) => {
      if (args.includes("read") || args.includes("get")) {
        readCount++;
        if (readCount === 1) return { success: true, stdout: "invalid json{{{", stderr: "", exitCode: 0 };
        return { success: true, stdout: makeReadOutput({ id: "msg2" }), stderr: "", exitCode: 0 };
      }
      if (args.includes("list")) return { success: true, stdout: makeListOutput([{ id: "msg1" }, { id: "msg2" }]), stderr: "", exitCode: 0 };
      return { success: true, stdout: "[]", stderr: "", exitCode: 0 };
    });
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBeGreaterThanOrEqual(1);
  });

  it("handles empty list", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("passes batchSize to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, batchSize: 5, db });
    const listCall = mockRun.mock.calls.find((c) => (c[1] as string[]).includes("list"));
    expect(listCall?.[1]).toContain("5");
  });

  it("passes query to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, query: "is:unread", db });
    const listCall = mockRun.mock.calls.find((c) => (c[1] as string[]).includes("list"));
    expect(listCall?.[1]).toContain("is:unread");
  });
});

// ─── syncGmailInboxAll ────────────────────────────────────────────────────────

describe("syncGmailInboxAll", () => {
  it("syncs single page", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "m1" }, { id: "m2" }]);
    const r = await syncGmailInboxAll({ providerId, db });
    expect(r.synced).toBe(2);
    expect(r.done).toBe(true);
  });
});
