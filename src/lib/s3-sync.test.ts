import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetDatabase, closeDatabase, getDatabase, uuid } from "../db/database.js";
import { createProvider } from "../db/providers.js";

// ─── Mock @aws-sdk/client-s3 ──────────────────────────────────────────────────

const mockSend = mock(async (_cmd: unknown) => ({}));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mockSend; },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  CreateBucketCommand: class { constructor(public input: unknown) {} },
  PutBucketPolicyCommand: class { constructor(public input: unknown) {} },
  PutPublicAccessBlockCommand: class { constructor(public input: unknown) {} },
  PutBucketVersioningCommand: class { constructor(public input: unknown) {} },
  PutBucketEncryptionCommand: class { constructor(public input: unknown) {} },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
}));

// ─── Mock mailparser ──────────────────────────────────────────────────────────

mock.module("mailparser", () => ({
  simpleParser: mock(async (_buf: unknown) => ({
    subject: "Test Subject",
    from: { text: "sender@example.com", value: [{ address: "sender@example.com" }] },
    to: { value: [{ address: "recipient@example.com" }] },
    cc: null,
    text: "Hello world",
    html: "<p>Hello world</p>",
    attachments: [],
    date: new Date("2026-03-01T10:00:00Z"),
    headers: new Map(),
  })),
}));

process.env["EMAILS_DB_PATH"] = ":memory:";
process.env["CLOUDFLARE_API_TOKEN"] = "mock-cf-token-for-tests";

const { syncS3Inbox } = await import("./s3-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'test', 'ses', 1)`, [providerId]);
  return { db, providerId };
}

beforeEach(() => {
  mockSend.mockReset();
});

afterEach(() => {
  closeDatabase();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("syncS3Inbox — empty bucket", () => {
  it("returns zero synced when no objects", async () => {
    const { db, providerId } = setupDb();

    // ListObjectsV2 returns empty
    mockSend.mockImplementation(async (cmd: { input?: { Prefix?: string } }) => {
      if (cmd?.input && "Prefix" in cmd.input) {
        return { Contents: [], IsTruncated: false };
      }
      return {};
    });

    const result = await syncS3Inbox({ bucket: "test-bucket", db, providerId });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("syncS3Inbox — with objects", () => {
  it("syncs new email objects from S3", async () => {
    const { db, providerId } = setupDb();
    let callCount = 0;

    mockSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { input?: Record<string, unknown> };
      // ListObjectsV2
      if (c?.input && "Prefix" in (c.input ?? {})) {
        if (callCount === 0) {
          callCount++;
          return {
            Contents: [{ Key: "inbound/example.com/msg001", Size: 1024 }],
            IsTruncated: false,
          };
        }
        return { Contents: [], IsTruncated: false };
      }
      // GetObjectCommand — return a simple async iterable
      if (c?.input && "Key" in (c.input ?? {})) {
        const rawEmail = Buffer.from("From: sender@example.com\r\nSubject: Test\r\n\r\nBody");
        return {
          Body: (async function* () { yield rawEmail; })(),
        };
      }
      return {};
    });

    const result = await syncS3Inbox({ bucket: "test-bucket", db, providerId });
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("skips already-synced objects (dedup by S3 key)", async () => {
    const { db, providerId } = setupDb();

    // Pre-insert with the S3 key as message_id
    db.run(
      `INSERT INTO inbound_emails (id, provider_id, message_id, from_address, to_addresses, cc_addresses, subject, attachments_json, attachment_paths, headers_json, raw_size, received_at, created_at)
       VALUES (?, ?, ?, 'a@b.com', '[]', '[]', 'S', '[]', '[]', '{}', 0, datetime('now'), datetime('now'))`,
      [uuid(), providerId, "inbound/example.com/msg001"],
    );

    mockSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { input?: Record<string, unknown> };
      if (c?.input && "Prefix" in (c.input ?? {})) {
        return {
          Contents: [{ Key: "inbound/example.com/msg001", Size: 1024 }],
          IsTruncated: false,
        };
      }
      return {};
    });

    const result = await syncS3Inbox({ bucket: "test-bucket", db, providerId });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("handles list error gracefully", async () => {
    const { db, providerId } = setupDb();

    mockSend.mockImplementation(async () => {
      throw new Error("S3 access denied");
    });

    const result = await syncS3Inbox({ bucket: "test-bucket", db, providerId });
    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to list S3 objects");
  });
});

describe("syncS3Inbox — result shape", () => {
  it("returns correct result shape", async () => {
    const { db, providerId } = setupDb();
    mockSend.mockImplementation(async () => ({ Contents: [], IsTruncated: false }));

    const result = await syncS3Inbox({ bucket: "test-bucket", db, providerId });
    expect(typeof result.synced).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(typeof result.attachments_saved).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.done).toBe("undefined"); // no done field in S3SyncResult
  });
});
