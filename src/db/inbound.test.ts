import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase, uuid } from "./database.js";
import {
  storeInboundEmail,
  getInboundEmail,
  listInboundEmails,
  deleteInboundEmail,
  clearInboundEmails,
  getInboundCount,
  listReplies,
  getReplyCount,
} from "./inbound.js";

function makeDb(): Database {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  return db;
}

function createProvider(db: Database, name = "test-provider"): string {
  const id = uuid();
  db.run(
    `INSERT INTO providers (id, name, type) VALUES (?, ?, 'sandbox')`,
    [id, name],
  );
  return id;
}

const sampleInput = {
  provider_id: null,
  message_id: "<test123@example.com>",
  from_address: "sender@example.com",
  to_addresses: ["receiver@example.com"],
  cc_addresses: [],
  subject: "Test subject",
  text_body: "Hello, world!",
  html_body: "<p>Hello, world!</p>",
  attachments: [],
  headers: { "content-type": "text/plain" },
  raw_size: 200,
  received_at: new Date().toISOString(),
};

describe("storeInboundEmail", () => {
  it("stores and returns an inbound email", () => {
    const db = makeDb();
    const email = storeInboundEmail(sampleInput, db);
    expect(email.id).toBeTruthy();
    expect(email.from_address).toBe("sender@example.com");
    expect(email.subject).toBe("Test subject");
    expect(email.to_addresses).toEqual(["receiver@example.com"]);
    expect(email.html_body).toBe("<p>Hello, world!</p>");
    expect(email.created_at).toBeTruthy();
  });

  it("stores email with null provider_id", () => {
    const db = makeDb();
    const email = storeInboundEmail({ ...sampleInput, provider_id: null }, db);
    expect(email.provider_id).toBeNull();
  });
});

describe("getInboundEmail", () => {
  it("retrieves a stored email by id", () => {
    const db = makeDb();
    const stored = storeInboundEmail(sampleInput, db);
    const retrieved = getInboundEmail(stored.id, db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(stored.id);
    expect(retrieved!.subject).toBe("Test subject");
  });

  it("returns null for unknown id", () => {
    const db = makeDb();
    expect(getInboundEmail("nonexistent-id", db)).toBeNull();
  });
});

describe("listInboundEmails", () => {
  it("lists all inbound emails", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail({ ...sampleInput, subject: "Second email" }, db);
    const list = listInboundEmails({}, db);
    expect(list.length).toBe(2);
  });

  it("filters by provider_id", () => {
    const db = makeDb();
    const provId = createProvider(db, "provider-x");
    storeInboundEmail(sampleInput, db);
    storeInboundEmail({ ...sampleInput, provider_id: provId }, db);
    const list = listInboundEmails({ provider_id: provId }, db);
    expect(list.length).toBe(1);
    expect(list[0]!.provider_id).toBe(provId);
  });

  it("respects limit option", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      storeInboundEmail({ ...sampleInput, subject: `Email ${i}` }, db);
    }
    const list = listInboundEmails({ limit: 3 }, db);
    expect(list.length).toBe(3);
  });

  it("respects offset option", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      storeInboundEmail({ ...sampleInput, subject: `Offset Email ${i}` }, db);
    }
    const page1 = listInboundEmails({ limit: 2, offset: 0 }, db).map((e) => e.id);
    const page2 = listInboundEmails({ limit: 2, offset: 2 }, db).map((e) => e.id);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page2).not.toEqual(page1);
    expect(page2.some((id) => page1.includes(id))).toBe(false);
  });

  it("returns empty array when none exist", () => {
    const db = makeDb();
    expect(listInboundEmails({}, db)).toEqual([]);
  });
});

describe("deleteInboundEmail", () => {
  it("deletes an email by id", () => {
    const db = makeDb();
    const email = storeInboundEmail(sampleInput, db);
    const result = deleteInboundEmail(email.id, db);
    expect(result).toBe(true);
    expect(getInboundEmail(email.id, db)).toBeNull();
  });

  it("returns false for unknown id", () => {
    const db = makeDb();
    expect(deleteInboundEmail("nonexistent", db)).toBe(false);
  });
});

describe("clearInboundEmails", () => {
  it("clears all inbound emails and returns count", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail(sampleInput, db);
    const count = clearInboundEmails(undefined, db);
    expect(count).toBe(2);
    expect(listInboundEmails({}, db)).toEqual([]);
  });

  it("clears by provider_id", () => {
    const db = makeDb();
    const provA = createProvider(db, "prov-a");
    const provB = createProvider(db, "prov-b");
    storeInboundEmail({ ...sampleInput, provider_id: provA }, db);
    storeInboundEmail({ ...sampleInput, provider_id: provB }, db);
    const count = clearInboundEmails(provA, db);
    expect(count).toBe(1);
    const remaining = listInboundEmails({}, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.provider_id).toBe(provB);
  });

  it("returns 0 when nothing to clear", () => {
    const db = makeDb();
    expect(clearInboundEmails(undefined, db)).toBe(0);
  });
});

describe("getInboundCount", () => {
  it("returns count of all inbound emails", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail(sampleInput, db);
    expect(getInboundCount(undefined, db)).toBe(2);
  });

  it("returns count filtered by provider_id", () => {
    const db = makeDb();
    const provA = createProvider(db, "prov-a");
    storeInboundEmail({ ...sampleInput, provider_id: provA }, db);
    storeInboundEmail(sampleInput, db);
    expect(getInboundCount(provA, db)).toBe(1);
  });
});

// Helper: insert a provider + email into DB, return the email ID
function insertSentEmail(db: Database, providerMsgId: string): string {
  const pId = uuid();
  db.run(`INSERT INTO providers (id, name, type) VALUES (?, 'p', 'sandbox')`, [pId]);
  const eId = uuid();
  db.run(
    `INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, 'hello@example.com', '[]', '[]', '[]', 'Hi', 'sent', datetime('now'), datetime('now'), datetime('now'))`,
    [eId, pId, providerMsgId],
  );
  return eId;
}

// ─── Reply tracking ────────────────────────────────────────────────────────────

describe("reply tracking (in_reply_to_email_id)", () => {
  it("stores in_reply_to_email_id when provided explicitly (valid FK)", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "explicit-msg-id");
    const email = storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(email.in_reply_to_email_id).toBe(sentId);
  });

  it("auto-detects reply via In-Reply-To header matching provider_message_id", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "original-msg-id-123");
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "In-Reply-To": "<original-msg-id-123>" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBe(sentId);
  });

  it("auto-detects via References header", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "ref-msg-456");
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "References": "other-id-111 <ref-msg-456> another-id-222" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBe(sentId);
  });

  it("returns null in_reply_to_email_id when no matching email found", () => {
    const db = makeDb();
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "In-Reply-To": "<nonexistent-msg-id>" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBeNull();
  });
});

// ─── listReplies + getReplyCount ───────────────────────────────────────────────

describe("listReplies", () => {
  it("lists inbound emails linked to a sent email", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "list-mid-1");
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(listReplies(sentId, db).length).toBe(2);
  });

  it("returns empty array when no replies", () => {
    const db = makeDb();
    expect(listReplies("nonexistent-email-id", db)).toEqual([]);
  });
});

describe("getReplyCount", () => {
  it("counts replies for a sent email", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "count-mid-2");
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(getReplyCount(sentId, db)).toBe(1);
  });

  it("returns 0 for email with no replies", () => {
    const db = makeDb();
    expect(getReplyCount("nonexistent", db)).toBe(0);
  });
});
