import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { storeInboundEmail, updateAttachmentPaths, getInboundEmail } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";

// ─── MIME parsing tests (via exported internals) ──────────────────────────────
// We test the shape of parsed messages indirectly through storeInboundEmail

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("inbound email with HTML body and attachment paths", () => {
  it("stores html_body correctly", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-001",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Hello",
      text_body: "Plain text",
      html_body: "<h1>Hello</h1><p>World</p>",
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 1234,
      received_at: new Date().toISOString(),
    });

    expect(email.html_body).toBe("<h1>Hello</h1><p>World</p>");
    expect(email.text_body).toBe("Plain text");
  });

  it("stores attachment metadata", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-002",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "With attachment",
      text_body: null,
      html_body: null,
      attachments: [
        { filename: "report.pdf", content_type: "application/pdf", size: 204800 },
        { filename: "photo.jpg", content_type: "image/jpeg", size: 512000 },
      ],
      attachment_paths: [],
      headers: {},
      raw_size: 716800,
      received_at: new Date().toISOString(),
    });

    expect(email.attachments).toHaveLength(2);
    expect(email.attachments[0]!.filename).toBe("report.pdf");
    expect(email.attachments[1]!.filename).toBe("photo.jpg");
    expect(email.attachment_paths).toHaveLength(0);
  });
});

describe("updateAttachmentPaths", () => {
  it("stores and retrieves local file paths", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-003",
      in_reply_to_email_id: null,
      from_address: "a@b.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Files",
      text_body: "See attachments",
      html_body: null,
      attachments: [{ filename: "data.csv", content_type: "text/csv", size: 1024 }],
      attachment_paths: [],
      headers: {},
      raw_size: 1024,
      received_at: new Date().toISOString(),
    });

    const paths: AttachmentPath[] = [
      {
        filename: "data.csv",
        content_type: "text/csv",
        size: 1024,
        local_path: "/home/user/.hasna/emails/attachments/abc123/data.csv",
      },
    ];

    updateAttachmentPaths(email.id, paths);

    const updated = getInboundEmail(email.id);
    expect(updated).not.toBeNull();
    expect(updated!.attachment_paths).toHaveLength(1);
    expect(updated!.attachment_paths[0]!.local_path).toBe("/home/user/.hasna/emails/attachments/abc123/data.csv");
    expect(updated!.attachment_paths[0]!.filename).toBe("data.csv");
  });

  it("stores and retrieves S3 URLs", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-004",
      in_reply_to_email_id: null,
      from_address: "a@b.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "S3 attachment",
      text_body: null,
      html_body: null,
      attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 65536 }],
      attachment_paths: [],
      headers: {},
      raw_size: 65536,
      received_at: new Date().toISOString(),
    });

    const paths: AttachmentPath[] = [
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 65536,
        s3_url: "s3://my-bucket/emails/abc456/invoice.pdf",
      },
    ];

    updateAttachmentPaths(email.id, paths);

    const updated = getInboundEmail(email.id);
    expect(updated!.attachment_paths[0]!.s3_url).toBe("s3://my-bucket/emails/abc456/invoice.pdf");
    expect(updated!.attachment_paths[0]!.local_path).toBeUndefined();
  });

  it("overwrites existing paths on second update", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-005",
      in_reply_to_email_id: null,
      from_address: "a@b.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Update test",
      text_body: null,
      html_body: null,
      attachments: [{ filename: "file.txt", content_type: "text/plain", size: 100 }],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: new Date().toISOString(),
    });

    updateAttachmentPaths(email.id, [{ filename: "file.txt", content_type: "text/plain", size: 100, local_path: "/tmp/v1.txt" }]);
    updateAttachmentPaths(email.id, [{ filename: "file.txt", content_type: "text/plain", size: 100, local_path: "/tmp/v2.txt" }]);

    const updated = getInboundEmail(email.id);
    expect(updated!.attachment_paths[0]!.local_path).toBe("/tmp/v2.txt");
  });
});

describe("attachment_paths defaults to empty array", () => {
  it("returns [] when no paths set", () => {
    const p = createProvider({ name: "gmail-test", type: "gmail" });
    const email = storeInboundEmail({
      provider_id: p.id,
      message_id: "msg-006",
      in_reply_to_email_id: null,
      from_address: "a@b.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "No attachments",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 4,
      received_at: new Date().toISOString(),
    });

    expect(email.attachment_paths).toEqual([]);
  });
});
