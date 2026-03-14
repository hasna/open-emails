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
