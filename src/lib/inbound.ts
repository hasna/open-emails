import { storeInboundEmail } from "../db/inbound.js";
import { getDatabase } from "../db/database.js";

export interface ParsedEmail {
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  headers: Record<string, string>;
  message_id: string | null;
}

/**
 * Parse a raw MIME email string into ParsedEmail fields.
 * Handles multipart/alternative and simple text/html emails.
 */
export function parseMimeEmail(raw: string): ParsedEmail {
  const headers: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  // Parse headers (until blank line)
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i++;
      break;
    }
    // Handle folded headers (continuation lines start with whitespace)
    if ((line.startsWith(" ") || line.startsWith("\t")) && Object.keys(headers).length > 0) {
      const lastKey = Object.keys(headers).pop()!;
      headers[lastKey] = (headers[lastKey] ?? "") + " " + line.trim();
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        headers[key] = value;
      }
    }
    i++;
  }

  const body = lines.slice(i).join("\n");

  const from_address = parseAddress(headers["from"] ?? "");
  const to_addresses = parseAddressList(headers["to"] ?? "");
  const cc_addresses = parseAddressList(headers["cc"] ?? "");
  const subject = decodeHeader(headers["subject"] ?? "");
  const message_id = headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null;

  const contentType = headers["content-type"] ?? "text/plain";

  let text_body: string | null = null;
  let html_body: string | null = null;

  if (contentType.includes("multipart/")) {
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!;
      const parts = splitMultipart(body, boundary);
      for (const part of parts) {
        const { headers: partHeaders, body: partBody } = parsePart(part);
        const partContentType = partHeaders["content-type"] ?? "text/plain";
        const encoding = (partHeaders["content-transfer-encoding"] ?? "").toLowerCase();
        const decoded = decodeBody(partBody, encoding);
        if (partContentType.includes("text/html") && !html_body) {
          html_body = decoded;
        } else if (partContentType.includes("text/plain") && !text_body) {
          text_body = decoded;
        }
      }
    }
  } else {
    const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
    const decoded = decodeBody(body, encoding);
    if (contentType.includes("text/html")) {
      html_body = decoded;
    } else {
      text_body = decoded;
    }
  }

  return {
    from_address,
    to_addresses,
    cc_addresses,
    subject,
    text_body,
    html_body,
    headers,
    message_id,
  };
}

function parseAddress(addr: string): string {
  if (!addr) return "";
  // "Display Name <email@example.com>" → "email@example.com"
  const match = addr.match(/<([^>]+)>/);
  return match ? match[1]!.trim() : addr.trim();
}

function parseAddressList(addrs: string): string[] {
  if (!addrs) return [];
  return addrs.split(",").map(a => parseAddress(a.trim())).filter(Boolean);
}

function decodeHeader(value: string): string {
  // Decode RFC 2047 encoded words: =?charset?encoding?text?=
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_full, __charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString("utf-8");
      } else {
        // Q encoding
        const decoded = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
        return decoded;
      }
    } catch {
      return text;
    }
  });
}

function decodeBody(body: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  const segments = body.split(new RegExp(`^--${escapeRegex(boundary)}(?:--)?\\s*$`, "m"));
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && seg.trim() && !seg.startsWith("--")) {
      parts.push(seg.trim());
    }
  }
  if (parts.length === 0) {
    // Fallback: manual split
    const lines = body.split("\n");
    let current: string[] = [];
    for (const line of lines) {
      if (line.startsWith(delimiter)) {
        if (current.length > 0) parts.push(current.join("\n"));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) parts.push(current.join("\n"));
  }
  return parts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePart(part: string): { headers: Record<string, string>; body: string } {
  const lines = part.replace(/\r\n/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i++;
      break;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
    i++;
  }
  return { headers, body: lines.slice(i).join("\n") };
}

/**
 * Parse Resend inbound webhook payload.
 * Resend sends inbound emails with a structured JSON payload.
 */
export function parseResendInbound(body: Record<string, unknown>): ParsedEmail {
  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      headers[k.toLowerCase()] = String(v);
    }
  }

  const from_address = parseAddress(String(body.from ?? body.sender ?? ""));
  const to_raw = body.to ?? body.recipient ?? "";
  const to_addresses = Array.isArray(to_raw)
    ? (to_raw as string[]).map(a => parseAddress(a))
    : [parseAddress(String(to_raw))];

  const cc_raw = body.cc ?? "";
  const cc_addresses = Array.isArray(cc_raw)
    ? (cc_raw as string[]).map(a => parseAddress(a))
    : cc_raw ? [parseAddress(String(cc_raw))] : [];

  return {
    from_address,
    to_addresses: to_addresses.filter(Boolean),
    cc_addresses: cc_addresses.filter(Boolean),
    subject: String(body.subject ?? ""),
    text_body: body.text ? String(body.text) : null,
    html_body: body.html ? String(body.html) : null,
    headers,
    message_id: body.message_id ? String(body.message_id) : (headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null),
  };
}

/**
 * Parse Mailgun inbound webhook payload.
 * Mailgun sends form-encoded data; by the time it reaches here it's been parsed into an object.
 */
export function parseMailgunInbound(body: Record<string, unknown>): ParsedEmail {
  const headers: Record<string, string> = {};

  // Mailgun sends raw headers as a string in "message-headers" field (JSON array of [name, value] pairs)
  if (body["message-headers"] && typeof body["message-headers"] === "string") {
    try {
      const rawHeaders = JSON.parse(body["message-headers"] as string) as [string, string][];
      for (const [name, value] of rawHeaders) {
        headers[name.toLowerCase()] = value;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const from_address = parseAddress(String(body.from ?? body.sender ?? ""));
  const to_raw = String(body.recipient ?? body.To ?? body.to ?? "");
  const to_addresses = to_raw.split(",").map(a => parseAddress(a.trim())).filter(Boolean);

  const cc_raw = String(body.Cc ?? body.cc ?? "");
  const cc_addresses = cc_raw ? cc_raw.split(",").map(a => parseAddress(a.trim())).filter(Boolean) : [];

  return {
    from_address,
    to_addresses,
    cc_addresses,
    subject: String(body.subject ?? body.Subject ?? ""),
    text_body: body["body-plain"] ? String(body["body-plain"]) : (body.text ? String(body.text) : null),
    html_body: body["body-html"] ? String(body["body-html"]) : (body.html ? String(body.html) : null),
    headers,
    message_id: body["Message-Id"]
      ? String(body["Message-Id"]).replace(/[<>]/g, "").trim()
      : (headers["message-id"]?.replace(/[<>]/g, "").trim() ?? null),
  };
}

interface SmtpServer {
  stop(): void;
}

/**
 * Start a minimal SMTP server using Bun's TCP server.
 * Accepts DATA commands, parses the raw email, and stores to inbound_emails.
 */
export function createSmtpServer(port: number, providerId?: string): SmtpServer {
  const db = getDatabase();

  const server = Bun.listen({
    hostname: "0.0.0.0",
    port,
    socket: {
      open(socket) {
        (socket as unknown as SmtpSocket).state = {
          stage: "greeting",
          from: "",
          to: [],
          data: [],
          collectingData: false,
        };
        socket.write("220 open-emails ESMTP ready\r\n");
      },
      data(socket, data) {
        const s = socket as unknown as SmtpSocket;
        const lines = data.toString().split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          handleSmtpLine(socket, s.state, line, db, providerId);
        }
      },
      error(_socket, error) {
        process.stderr.write(`[SMTP] Socket error: ${error.message}\n`);
      },
      close() {
        // Connection closed
      },
    },
  });

  process.stderr.write(`[SMTP] Listening on port ${port}\n`);

  return {
    stop() {
      server.stop();
    },
  };
}

interface SmtpState {
  stage: "greeting" | "ready" | "mail" | "rcpt" | "data" | "done";
  from: string;
  to: string[];
  data: string[];
  collectingData: boolean;
}

interface SmtpSocket {
  state: SmtpState;
  write(data: string): void;
}

function handleSmtpLine(
  socket: { write(data: string): void },
  state: SmtpState,
  line: string,
  db: ReturnType<typeof getDatabase>,
  providerId?: string,
): void {
  const upper = line.toUpperCase();

  if (state.collectingData) {
    if (line === ".") {
      // End of DATA
      state.collectingData = false;
      state.stage = "done";
      const raw = state.data.join("\n");
      try {
        const parsed = parseMimeEmail(raw);
        const stored = storeInboundEmail(
          {
            provider_id: providerId ?? null,
            message_id: parsed.message_id,
            from_address: parsed.from_address || state.from,
            to_addresses: parsed.to_addresses.length > 0 ? parsed.to_addresses : state.to,
            cc_addresses: parsed.cc_addresses,
            subject: parsed.subject,
            text_body: parsed.text_body,
            html_body: parsed.html_body,
            attachments: [],
            headers: parsed.headers,
            raw_size: raw.length,
            received_at: new Date().toISOString(),
          },
          db,
        );
        process.stderr.write(
          `[SMTP] Received email from=${stored.from_address} to=${stored.to_addresses.join(",")} subject="${stored.subject}" id=${stored.id.slice(0, 8)}\n`,
        );
      } catch (err) {
        process.stderr.write(`[SMTP] Failed to store email: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      socket.write("250 OK: message queued\r\n");
      // Reset for next message
      state.stage = "ready";
      state.from = "";
      state.to = [];
      state.data = [];
    } else {
      // Handle dot-stuffing: leading dot on non-terminating lines
      state.data.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return;
  }

  if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
    state.stage = "ready";
    socket.write("250-open-emails\r\n250-SIZE 10485760\r\n250 OK\r\n");
  } else if (upper.startsWith("MAIL FROM:")) {
    state.from = extractAngle(line.slice(10));
    state.stage = "mail";
    socket.write("250 OK\r\n");
  } else if (upper.startsWith("RCPT TO:")) {
    state.to.push(extractAngle(line.slice(8)));
    state.stage = "rcpt";
    socket.write("250 OK\r\n");
  } else if (upper === "DATA") {
    if (state.stage !== "rcpt" && state.stage !== "mail") {
      socket.write("503 Bad sequence of commands\r\n");
    } else {
      state.stage = "data";
      state.collectingData = true;
      state.data = [];
      socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
    }
  } else if (upper === "QUIT") {
    socket.write("221 Bye\r\n");
  } else if (upper === "RSET") {
    state.stage = "ready";
    state.from = "";
    state.to = [];
    state.data = [];
    state.collectingData = false;
    socket.write("250 OK\r\n");
  } else if (upper.startsWith("NOOP")) {
    socket.write("250 OK\r\n");
  } else {
    socket.write("500 Command not recognized\r\n");
  }
}

function extractAngle(s: string): string {
  const match = s.trim().match(/<([^>]*)>/);
  return match ? match[1]! : s.trim();
}
