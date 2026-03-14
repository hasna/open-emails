import { describe, it, expect } from "bun:test";
import { parseMimeEmail, parseResendInbound, parseMailgunInbound } from "./inbound.js";

const SIMPLE_TEXT_EMAIL = [
  "From: Sender Name <sender@example.com>",
  "To: receiver@example.com",
  "Subject: Hello World",
  "Message-ID: <abc123@example.com>",
  "Content-Type: text/plain",
  "",
  "This is the body.",
].join("\r\n");

const SIMPLE_HTML_EMAIL = [
  "From: sender@example.com",
  "To: a@example.com, b@example.com",
  "CC: cc@example.com",
  "Subject: HTML Email",
  "Message-ID: <html123@example.com>",
  "Content-Type: text/html",
  "",
  "<p>Hello!</p>",
].join("\r\n");

const MULTIPART_EMAIL = [
  "From: sender@example.com",
  "To: receiver@example.com",
  "Subject: Multipart Email",
  "Message-ID: <multi@example.com>",
  'Content-Type: multipart/alternative; boundary="boundary123"',
  "",
  "--boundary123",
  "Content-Type: text/plain",
  "",
  "Text body here",
  "--boundary123",
  "Content-Type: text/html",
  "",
  "<p>HTML body here</p>",
  "--boundary123--",
].join("\r\n");

describe("parseMimeEmail", () => {
  it("parses a simple text email", () => {
    const result = parseMimeEmail(SIMPLE_TEXT_EMAIL);
    expect(result.from_address).toBe("sender@example.com");
    expect(result.to_addresses).toEqual(["receiver@example.com"]);
    expect(result.subject).toBe("Hello World");
    expect(result.text_body).toContain("This is the body.");
    expect(result.html_body).toBeNull();
    expect(result.message_id).toBe("abc123@example.com");
  });

  it("parses a simple HTML email", () => {
    const result = parseMimeEmail(SIMPLE_HTML_EMAIL);
    expect(result.from_address).toBe("sender@example.com");
    expect(result.to_addresses).toEqual(["a@example.com", "b@example.com"]);
    expect(result.cc_addresses).toEqual(["cc@example.com"]);
    expect(result.subject).toBe("HTML Email");
    expect(result.html_body).toContain("<p>Hello!</p>");
    expect(result.text_body).toBeNull();
  });

  it("parses a multipart/alternative email", () => {
    const result = parseMimeEmail(MULTIPART_EMAIL);
    expect(result.subject).toBe("Multipart Email");
    expect(result.text_body).toContain("Text body here");
    expect(result.html_body).toContain("<p>HTML body here</p>");
  });

  it("parses headers into an object", () => {
    const result = parseMimeEmail(SIMPLE_TEXT_EMAIL);
    expect(result.headers["from"]).toBeTruthy();
    expect(result.headers["subject"]).toBe("Hello World");
  });

  it("handles email with no body gracefully", () => {
    const raw = "From: a@b.com\r\nSubject: Empty\r\n\r\n";
    const result = parseMimeEmail(raw);
    expect(result.subject).toBe("Empty");
    expect(result.from_address).toBe("a@b.com");
  });
});

describe("parseResendInbound", () => {
  it("parses a Resend inbound payload", () => {
    const payload = {
      from: "sender@example.com",
      to: ["receiver@example.com"],
      cc: ["cc@example.com"],
      subject: "Resend test",
      text: "Hello from Resend",
      html: "<p>Hello from Resend</p>",
      message_id: "resend-msg-123",
    };
    const result = parseResendInbound(payload);
    expect(result.from_address).toBe("sender@example.com");
    expect(result.to_addresses).toEqual(["receiver@example.com"]);
    expect(result.cc_addresses).toEqual(["cc@example.com"]);
    expect(result.subject).toBe("Resend test");
    expect(result.text_body).toBe("Hello from Resend");
    expect(result.html_body).toBe("<p>Hello from Resend</p>");
    expect(result.message_id).toBe("resend-msg-123");
  });

  it("handles missing optional fields", () => {
    const payload = {
      from: "a@b.com",
      to: "c@d.com",
      subject: "Minimal",
    };
    const result = parseResendInbound(payload);
    expect(result.from_address).toBe("a@b.com");
    expect(result.to_addresses).toEqual(["c@d.com"]);
    expect(result.text_body).toBeNull();
    expect(result.html_body).toBeNull();
    expect(result.message_id).toBeNull();
  });

  it("parses angle-bracket addresses", () => {
    const payload = {
      from: "Sender Name <sender@example.com>",
      to: ["Receiver <receiver@example.com>"],
      subject: "Test",
    };
    const result = parseResendInbound(payload);
    expect(result.from_address).toBe("sender@example.com");
    expect(result.to_addresses).toEqual(["receiver@example.com"]);
  });
});

describe("parseMailgunInbound", () => {
  it("parses a Mailgun inbound payload", () => {
    const payload = {
      from: "sender@example.com",
      recipient: "receiver@example.com",
      subject: "Mailgun test",
      "body-plain": "Plain text body",
      "body-html": "<p>HTML body</p>",
      "Message-Id": "<mailgun-123@example.com>",
      "message-headers": JSON.stringify([
        ["From", "sender@example.com"],
        ["Subject", "Mailgun test"],
      ]),
    };
    const result = parseMailgunInbound(payload);
    expect(result.from_address).toBe("sender@example.com");
    expect(result.to_addresses).toEqual(["receiver@example.com"]);
    expect(result.subject).toBe("Mailgun test");
    expect(result.text_body).toBe("Plain text body");
    expect(result.html_body).toBe("<p>HTML body</p>");
    expect(result.message_id).toBe("mailgun-123@example.com");
  });

  it("handles missing optional fields", () => {
    const payload = {
      sender: "a@b.com",
      recipient: "c@d.com",
      Subject: "Minimal",
    };
    const result = parseMailgunInbound(payload);
    expect(result.to_addresses).toEqual(["c@d.com"]);
    expect(result.text_body).toBeNull();
    expect(result.html_body).toBeNull();
  });

  it("parses CC addresses", () => {
    const payload = {
      from: "a@b.com",
      recipient: "c@d.com",
      Cc: "cc1@x.com, cc2@y.com",
      subject: "CC test",
    };
    const result = parseMailgunInbound(payload);
    expect(result.cc_addresses).toEqual(["cc1@x.com", "cc2@y.com"]);
  });
});
