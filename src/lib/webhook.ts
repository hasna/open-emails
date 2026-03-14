import { upsertEvent } from "../db/events.js";
import { getDatabase } from "../db/database.js";
import chalk from "chalk";

/**
 * Verify Resend webhook signature (svix-style HMAC-SHA256).
 * Resend sends: svix-id, svix-timestamp, svix-signature headers.
 * The signed content is: `{svix-id}.{svix-timestamp}.{body}`
 */
export async function verifyResendSignature(
  body: string,
  headers: Record<string, string | null>,
  secret: string,
): Promise<boolean> {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSignature = headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject if timestamp is more than 5 minutes old
  const ts = parseInt(svixTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedContent));
  const computed = "v1," + Buffer.from(sig).toString("base64");

  // svix-signature may be multiple signatures separated by spaces
  return svixSignature.split(" ").some(s => s === computed);
}

/**
 * Verify SES/SNS webhook signature.
 * SNS signs with its own certificate — we do a basic check that the message
 * comes from an SNS source (Type=Notification). Full cert verification requires
 * downloading the cert from AWS which is optional — we at least check the structure.
 */
export function verifySnsStructure(body: Record<string, unknown>): boolean {
  // If Type is present, ensure it's an SNS type
  if (body.Type && body.Type !== "Notification" && body.Type !== "SubscriptionConfirmation") return false;
  // If TopicArn is present, ensure it's an AWS ARN (arn:aws:sns:...)
  const topicArn = body.TopicArn as string | undefined;
  if (topicArn && !topicArn.startsWith("arn:aws")) return false;
  return true;
}

export interface WebhookEvent {
  provider_event_id: string;
  type: "delivered" | "bounced" | "complained" | "opened" | "clicked";
  recipient?: string;
  provider_message_id?: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export function parseResendWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.opened": "opened",
    "email.clicked": "clicked",
  };
  const eventType = typeMap[body.type];
  if (!eventType) return null;
  return {
    provider_event_id: body.data?.email_id || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: Array.isArray(body.data?.to) ? body.data.to[0] : body.data?.to,
    provider_message_id: body.data?.email_id,
    occurred_at: body.data?.created_at || new Date().toISOString(),
    metadata: body.data || {},
  };
}

export function parseSesWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    Delivery: "delivered",
    Bounce: "bounced",
    Complaint: "complained",
  };
  const eventType = typeMap[body.notificationType];
  if (!eventType) return null;
  const messageId = body.mail?.messageId;
  const recipients = body.mail?.destination || [];
  return {
    provider_event_id: body.mail?.messageId || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: recipients[0],
    provider_message_id: messageId,
    occurred_at: body.mail?.timestamp || new Date().toISOString(),
    metadata: body,
  };
}

function colorEventType(type: string): string {
  switch (type) {
    case "delivered": return chalk.green(type);
    case "bounced": return chalk.red(type);
    case "complained": return chalk.red(type);
    case "opened": return chalk.blue(type);
    case "clicked": return chalk.cyan(type);
    default: return type;
  }
}

export function createWebhookServer(port: number, providerId?: string, webhookSecret?: string) {
  const db = getDatabase();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let event: WebhookEvent | null = null;
      let bodyText: string;
      let body: any;

      try {
        bodyText = await req.text();
        body = JSON.parse(bodyText);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (url.pathname === "/webhook/resend") {
        // Verify Resend signature if secret is configured
        if (webhookSecret) {
          const headers: Record<string, string | null> = {
            "svix-id": req.headers.get("svix-id"),
            "svix-timestamp": req.headers.get("svix-timestamp"),
            "svix-signature": req.headers.get("svix-signature"),
          };
          const valid = await verifyResendSignature(bodyText, headers, webhookSecret).catch(() => false);
          if (!valid) return new Response("Invalid signature", { status: 401 });
        }
        event = parseResendWebhook(body);
      } else if (url.pathname === "/webhook/ses") {
        // Verify SNS structure
        if (!verifySnsStructure(body)) return new Response("Invalid SNS payload", { status: 400 });
        event = parseSesWebhook(body);
      } else {
        return new Response("Not found", { status: 404 });
      }

      if (!event) {
        return new Response("Unrecognized event type", { status: 200 });
      }

      // Determine provider ID — use provided one or try to find from path
      const pId = providerId || "webhook";

      try {
        upsertEvent(
          {
            provider_id: pId,
            provider_event_id: event.provider_event_id,
            type: event.type,
            recipient: event.recipient || null,
            metadata: event.metadata || {},
            occurred_at: event.occurred_at,
          },
          db,
        );
      } catch {
        // If provider_id doesn't exist in providers table, just log
      }

      const timestamp = new Date().toLocaleTimeString();
      console.log(
        `${chalk.gray(`[${timestamp}]`)} ${colorEventType(event.type)}  ${event.recipient || "unknown"}  ${chalk.dim(event.provider_event_id.slice(0, 12))}`,
      );

      return new Response("OK", { status: 200 });
    },
  });

  return server;
}
