import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  storeSandboxEmail,
  listSandboxEmails,
  getSandboxEmail,
  clearSandboxEmails,
  getSandboxCount,
} from "./sandbox.js";

function makeProvider() {
  return createProvider({ name: "Sandbox Test", type: "sandbox" });
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase(); // initialize schema
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("storeSandboxEmail", () => {
  it("stores an email and returns it with parsed arrays", () => {
    const provider = makeProvider();
    const db = getDatabase();
    const email = storeSandboxEmail(
      {
        provider_id: provider.id,
        from_address: "from@example.com",
        to_addresses: ["to@example.com"],
        cc_addresses: [],
        bcc_addresses: [],
        reply_to: null,
        subject: "Hello sandbox",
        html: "<p>Hello</p>",
        text_body: "Hello",
        attachments: [],
        headers: {},
      },
      db,
    );

    expect(email.id).toHaveLength(36);
    expect(email.provider_id).toBe(provider.id);
    expect(email.from_address).toBe("from@example.com");
    expect(email.to_addresses).toEqual(["to@example.com"]);
    expect(email.cc_addresses).toEqual([]);
    expect(email.bcc_addresses).toEqual([]);
    expect(email.reply_to).toBeNull();
    expect(email.subject).toBe("Hello sandbox");
    expect(email.html).toBe("<p>Hello</p>");
    expect(email.text_body).toBe("Hello");
    expect(email.attachments).toEqual([]);
    expect(email.headers).toEqual({});
    expect(email.created_at).toBeTruthy();
  });

  it("stores multiple recipients in to/cc/bcc", () => {
    const provider = makeProvider();
    const db = getDatabase();
    const email = storeSandboxEmail(
      {
        provider_id: provider.id,
        from_address: "from@example.com",
        to_addresses: ["a@example.com", "b@example.com"],
        cc_addresses: ["cc@example.com"],
        bcc_addresses: ["bcc@example.com"],
        reply_to: "reply@example.com",
        subject: "Multi",
        html: null,
        text_body: "text",
        attachments: [],
        headers: { "X-Custom": "value" },
      },
      db,
    );

    expect(email.to_addresses).toEqual(["a@example.com", "b@example.com"]);
    expect(email.cc_addresses).toEqual(["cc@example.com"]);
    expect(email.bcc_addresses).toEqual(["bcc@example.com"]);
    expect(email.reply_to).toBe("reply@example.com");
    expect(email.headers).toEqual({ "X-Custom": "value" });
  });
});

describe("listSandboxEmails", () => {
  it("returns all emails when no provider filter", () => {
    const p1 = makeProvider();
    const p2 = createProvider({ name: "Sandbox 2", type: "sandbox" });
    const db = getDatabase();

    storeSandboxEmail({ provider_id: p1.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "Email 1", html: null, text_body: "t", attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p2.id, from_address: "c@c.com", to_addresses: ["d@d.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "Email 2", html: null, text_body: "t", attachments: [], headers: {} }, db);

    const all = listSandboxEmails(undefined, 50, db);
    expect(all.length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p1 = makeProvider();
    const p2 = createProvider({ name: "Sandbox 2", type: "sandbox" });
    const db = getDatabase();

    storeSandboxEmail({ provider_id: p1.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P1 Email", html: null, text_body: "t", attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p2.id, from_address: "c@c.com", to_addresses: ["d@d.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P2 Email", html: null, text_body: "t", attachments: [], headers: {} }, db);

    const p1Emails = listSandboxEmails(p1.id, 50, db);
    expect(p1Emails.length).toBe(1);
    expect(p1Emails[0]!.subject).toBe("P1 Email");

    const p2Emails = listSandboxEmails(p2.id, 50, db);
    expect(p2Emails.length).toBe(1);
    expect(p2Emails[0]!.subject).toBe("P2 Email");
  });

  it("respects limit", () => {
    const p = makeProvider();
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      storeSandboxEmail({ provider_id: p.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: `Email ${i}`, html: null, text_body: "t", attachments: [], headers: {} }, db);
    }
    const limited = listSandboxEmails(undefined, 3, db);
    expect(limited.length).toBe(3);
  });

  it("respects offset", () => {
    const p = makeProvider();
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      storeSandboxEmail({ provider_id: p.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: `Offset ${i}`, html: null, text_body: "t", attachments: [], headers: {} }, db);
    }

    const page1 = listSandboxEmails(undefined, 2, 0, db).map((e) => e.id);
    const page2 = listSandboxEmails(undefined, 2, 2, db).map((e) => e.id);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page2).not.toEqual(page1);
    expect(page2.some((id) => page1.includes(id))).toBe(false);
  });
});

describe("getSandboxEmail", () => {
  it("returns the email by id", () => {
    const provider = makeProvider();
    const db = getDatabase();
    const stored = storeSandboxEmail({ provider_id: provider.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "Find me", html: null, text_body: null, attachments: [], headers: {} }, db);

    const found = getSandboxEmail(stored.id, db);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(stored.id);
    expect(found!.subject).toBe("Find me");
  });

  it("returns null for unknown id", () => {
    const db = getDatabase();
    const result = getSandboxEmail("nonexistent-id", db);
    expect(result).toBeNull();
  });
});

describe("clearSandboxEmails", () => {
  it("clears all emails and returns count", () => {
    const provider = makeProvider();
    const db = getDatabase();
    storeSandboxEmail({ provider_id: provider.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "S1", html: null, text_body: null, attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: provider.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "S2", html: null, text_body: null, attachments: [], headers: {} }, db);

    const deleted = clearSandboxEmails(undefined, db);
    expect(deleted).toBe(2);
    expect(listSandboxEmails(undefined, 50, db).length).toBe(0);
  });

  it("clears only emails for specified provider", () => {
    const p1 = makeProvider();
    const p2 = createProvider({ name: "Sandbox 2", type: "sandbox" });
    const db = getDatabase();

    storeSandboxEmail({ provider_id: p1.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P1 Email", html: null, text_body: null, attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p2.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P2 Email", html: null, text_body: null, attachments: [], headers: {} }, db);

    const deleted = clearSandboxEmails(p1.id, db);
    expect(deleted).toBe(1);

    const remaining = listSandboxEmails(undefined, 50, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.provider_id).toBe(p2.id);
  });

  it("returns 0 when nothing to clear", () => {
    const db = getDatabase();
    const deleted = clearSandboxEmails(undefined, db);
    expect(deleted).toBe(0);
  });
});

describe("getSandboxCount", () => {
  it("returns total count without filter", () => {
    const p = makeProvider();
    const db = getDatabase();
    expect(getSandboxCount(undefined, db)).toBe(0);
    storeSandboxEmail({ provider_id: p.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "S1", html: null, text_body: null, attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "S2", html: null, text_body: null, attachments: [], headers: {} }, db);
    expect(getSandboxCount(undefined, db)).toBe(2);
  });

  it("returns count for specific provider", () => {
    const p1 = makeProvider();
    const p2 = createProvider({ name: "Sandbox 2", type: "sandbox" });
    const db = getDatabase();

    storeSandboxEmail({ provider_id: p1.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P1", html: null, text_body: null, attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p1.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P1 2", html: null, text_body: null, attachments: [], headers: {} }, db);
    storeSandboxEmail({ provider_id: p2.id, from_address: "a@a.com", to_addresses: ["b@b.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "P2", html: null, text_body: null, attachments: [], headers: {} }, db);

    expect(getSandboxCount(p1.id, db)).toBe(2);
    expect(getSandboxCount(p2.id, db)).toBe(1);
  });
});
