import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetDatabase, closeDatabase, getDatabase, uuid } from "../db/database.js";

// ─── Mock @hasna/connect-gmail ────────────────────────────────────────────────
// Build before import so the mock is in place

type MockMessage = {
  id: string;
  payload?: {
    headers?: { name: string; value: string }[];
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  };
  sizeEstimate?: number;
  internalDate?: string;
};

type MockAttachment = { attachmentId: string; filename: string; mimeType: string; size: number; partId: string };
type MockDownloaded = { filename: string; path: string; size: number; mimeType: string };

// Mutable state controlled per-test
let mockMessages: MockMessage[] = [];
let mockNextPageToken: string | undefined;
let mockListError: Error | null = null;
let mockAttachments: MockAttachment[] = [];
let mockDownloaded: MockDownloaded[] = [];

function makeHeaders(from: string, to: string, subject: string, date: string) {
  return [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
    { name: "Date", value: date },
  ];
}

const mockGmailInstance = {
  messages: {
    list: mock(async (opts: { maxResults?: number; labelIds?: string[]; q?: string; pageToken?: string }) => {
      if (mockListError) throw mockListError;
      return {
        messages: mockMessages.map(m => ({ id: m.id })),
        nextPageToken: mockNextPageToken,
      };
    }),
    get: mock(async (id: string, _format: string) => {
      const msg = mockMessages.find(m => m.id === id);
      if (!msg) throw new Error(`Message not found: ${id}`);
      return msg;
    }),
    extractBody: mock((msg: MockMessage, preferHtml: boolean) => {
      // Find the body text from our mock data
      const key = preferHtml ? "__htmlBody" : "__textBody";
      return (msg as Record<string, unknown>)[key] as string ?? "";
    }),
  },
  attachments: {
    list: mock(async (_messageId: string) => mockAttachments),
    downloadAll: mock(async (_messageId: string, _outputDir: string) => mockDownloaded),
  },
  labels: {
    list: mock(async () => ({ labels: [{ id: "INBOX", name: "INBOX" }] })),
  },
};

mock.module("@hasna/connect-gmail", () => ({
  Gmail: {
    createWithTokens: mock((_tokens: unknown, _onRefresh?: unknown) => mockGmailInstance),
    create: mock(() => mockGmailInstance),
  },
}));

// Import after mock
const { syncGmailInbox, syncGmailInboxAll } = await import("./gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  const providerId = uuid();
  db.run(
    `INSERT INTO providers (id, name, type, oauth_client_id, oauth_client_secret, oauth_refresh_token, active)
     VALUES (?, 'gmail-test', 'gmail', 'client-id', 'client-secret', 'refresh-token', 1)`,
    [providerId],
  );
  return { db, providerId };
}

function makeMsg(id: string, from: string, subject: string, textBody: string): MockMessage {
  const msg = {
    id,
    payload: { headers: makeHeaders(from, "me@example.com", subject, "Fri, 20 Mar 2026 10:00:00 +0000") },
    sizeEstimate: 500,
    __textBody: textBody,
    __htmlBody: `<p>${textBody}</p>`,
  };
  return msg as MockMessage;
}

beforeEach(() => {
  mockMessages = [];
  mockNextPageToken = undefined;
  mockListError = null;
  mockAttachments = [];
  mockDownloaded = [];
  mockGmailInstance.messages.list.mockReset();
  mockGmailInstance.messages.get.mockReset();
  mockGmailInstance.attachments.list.mockReset();
  mockGmailInstance.attachments.downloadAll.mockReset();

  // Restore default implementations
  mockGmailInstance.messages.list.mockImplementation(async () => ({
    messages: mockMessages.map(m => ({ id: m.id })),
    nextPageToken: mockNextPageToken,
  }));
  mockGmailInstance.messages.get.mockImplementation(async (id: string) => {
    const msg = mockMessages.find(m => m.id === id);
    if (!msg) throw new Error(`Message not found: ${id}`);
    return msg;
  });
  mockGmailInstance.attachments.list.mockImplementation(async () => mockAttachments);
  mockGmailInstance.attachments.downloadAll.mockImplementation(async () => mockDownloaded);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

// ─── syncGmailInbox ───────────────────────────────────────────────────────────

describe("syncGmailInbox", () => {
  it("syncs two messages into inbound_emails", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [
      makeMsg("msg1", "alice@example.com", "Hello", "Hello there!"),
      makeMsg("msg2", "bob@example.com", "World", "World content."),
    ];

    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const rows = db.query("SELECT * FROM inbound_emails WHERE provider_id = ?").all(providerId) as { message_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.message_id).sort()).toEqual(["msg1", "msg2"]);
  });

  it("skips already-synced messages (dedup)", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "a@b.com", "Dup", "body")];

    await syncGmailInbox({ providerId, db });
    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("stores correct fields from Gmail message", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "alice@example.com", "Hello", "Hello there!")];

    await syncGmailInbox({ providerId, db });

    const row = db.query("SELECT * FROM inbound_emails WHERE message_id = 'msg1'").get() as {
      from_address: string; subject: string; text_body: string; html_body: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.from_address).toBe("alice@example.com");
    expect(row!.subject).toBe("Hello");
    expect(row!.text_body).toBe("Hello there!");
    expect(row!.html_body).toBe("<p>Hello there!</p>");
  });

  it("returns error when list fails", async () => {
    const { db, providerId } = setupDb();
    mockGmailInstance.messages.list.mockImplementation(async () => {
      throw new Error("auth error");
    });

    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to list messages");
  });

  it("isolates per-message errors", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [
      makeMsg("msg-ok", "a@b.com", "OK", "body"),
      makeMsg("msg-err", "b@c.com", "Err", "body"),
    ];
    mockGmailInstance.messages.get.mockImplementation(async (id: string) => {
      if (id === "msg-err") throw new Error("fetch failed");
      return mockMessages.find(m => m.id === id)!;
    });

    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it("handles empty list gracefully", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [];

    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("passes nextPageToken when present", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "a@b.com", "S", "b")];
    mockNextPageToken = "token-abc";

    const result = await syncGmailInbox({ providerId, db });
    expect(result.done).toBe(false);
    expect(result.nextPageToken).toBe("token-abc");
  });

  it("stores attachments metadata", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "a@b.com", "With attachment", "body")];
    mockAttachments = [{ attachmentId: "att1", filename: "doc.pdf", mimeType: "application/pdf", size: 1024, partId: "2" }];
    mockDownloaded = [{ filename: "doc.pdf", path: "/tmp/doc.pdf", size: 1024, mimeType: "application/pdf" }];

    const result = await syncGmailInbox({ providerId, db, downloadAttachments: true });
    expect(result.synced).toBe(1);
    expect(result.attachments_saved).toBe(1);

    const row = db.query("SELECT attachments_json, attachment_paths FROM inbound_emails WHERE message_id = 'msg1'").get() as {
      attachments_json: string; attachment_paths: string;
    } | null;
    expect(row).not.toBeNull();
    const att = JSON.parse(row!.attachments_json) as { filename: string }[];
    expect(att[0]?.filename).toBe("doc.pdf");
    const paths = JSON.parse(row!.attachment_paths) as { local_path: string }[];
    expect(paths[0]?.local_path).toBe("/tmp/doc.pdf");
  });

  it("skips attachments when downloadAttachments=false", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "a@b.com", "S", "b")];
    mockAttachments = [{ attachmentId: "att1", filename: "doc.pdf", mimeType: "application/pdf", size: 1024, partId: "2" }];

    const result = await syncGmailInbox({ providerId, db, downloadAttachments: false });
    expect(result.attachments_saved).toBe(0);
    expect(mockGmailInstance.attachments.downloadAll).not.toHaveBeenCalled();
  });
});

// ─── syncGmailInboxAll ────────────────────────────────────────────────────────

describe("syncGmailInboxAll", () => {
  it("syncs single page when done", async () => {
    const { db, providerId } = setupDb();
    mockMessages = [makeMsg("msg1", "a@b.com", "S", "b"), makeMsg("msg2", "c@d.com", "T", "b2")];

    const result = await syncGmailInboxAll({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.done).toBe(true);
  });

  it("paginates across multiple pages", async () => {
    const { db, providerId } = setupDb();
    let page = 0;

    mockGmailInstance.messages.list.mockImplementation(async () => {
      page++;
      if (page === 1) return { messages: [{ id: "p1" }], nextPageToken: "tok2" };
      return { messages: [{ id: "p2" }] };
    });
    mockGmailInstance.messages.get.mockImplementation(async (id: string) => ({
      id,
      payload: { headers: makeHeaders("a@b.com", "me@example.com", "S", "Fri, 20 Mar 2026 10:00:00 +0000") },
      sizeEstimate: 100,
      __textBody: "body",
    }));

    const result = await syncGmailInboxAll({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.done).toBe(true);
  });
});
