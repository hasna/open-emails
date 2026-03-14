# @hasna/emails

Email management CLI + MCP server for AI agents. Send, log, search, and analyse emails across Resend, AWS SES, and Gmail from a single terminal interface or via MCP tools that any AI agent can call.

## Install

```bash
npm install -g @hasna/emails
# or
bun add -g @hasna/emails
```

## Quick Start (5 commands to send your first email)

```bash
# 1. Add a Resend provider
emails provider add --name "My Resend" --type resend --api-key re_xxxx

# 2. Add a sending domain
emails domain add yourdomain.com --provider <provider-id>

# 3. Check DNS records to configure in your DNS registrar
emails domain dns yourdomain.com

# 4. Add a sender address
emails address add hello@yourdomain.com --provider <provider-id>

# 5. Send your first email
emails send --from hello@yourdomain.com --to you@example.com \
  --subject "Hello from emails CLI" --body "It works!"
```

## Providers

### Resend Setup

```bash
emails provider add \
  --name "Resend Production" \
  --type resend \
  --api-key re_YOUR_API_KEY
```

Get your API key at [resend.com/api-keys](https://resend.com/api-keys).

### AWS SES Setup

```bash
emails provider add \
  --name "SES Production" \
  --type ses \
  --region us-east-1 \
  --access-key AKIAIOSFODNN7EXAMPLE \
  --secret-key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

The IAM user needs `ses:SendEmail`, `ses:GetIdentity`, and `ses:ListIdentities` permissions.

### Gmail OAuth Setup

```bash
emails provider add \
  --name "My Gmail" \
  --type gmail \
  --client-id YOUR_OAUTH_CLIENT_ID \
  --client-secret YOUR_OAUTH_CLIENT_SECRET
```

The command opens a browser for the OAuth consent flow and saves the refresh token automatically. To re-authenticate (when tokens expire):

```bash
emails provider auth <provider-id>
```

## Sandbox Provider (Dev Mode)

The sandbox provider captures emails locally without delivering them — ideal for development and CI.

```bash
emails provider add --name dev --type sandbox
```

Use it like any other provider. Emails sent to it are stored in the local database and printed to stderr:

```
[sandbox] Email captured: Welcome, Alice → alice@example.com (id: abc12345)
```

Inspect captured emails:

```bash
emails sandbox list                    # List all captured emails
emails sandbox show <id>               # Show full email details
emails sandbox open <id>               # Open HTML in browser
emails sandbox clear                   # Delete all captured emails
emails sandbox count                   # Show count
```

## Inbound Email

Receive inbound emails over SMTP or via a webhook from Resend.

### SMTP listener

```bash
emails inbound listen --port 2525
```

Starts a minimal SMTP server. Point your mail transfer agent (or test scripts) at `localhost:2525`.

### Resend inbound webhook

In the Resend dashboard configure an inbound route pointing to `POST /api/inbound` on your server (or expose locally with ngrok). The endpoint accepts Resend's inbound JSON payload and stores the email.

```bash
# Expose locally for testing
ngrok http 3456
emails webhook --port 3456
# Then configure https://your-ngrok-url/api/inbound in Resend
```

### Inspect inbound emails

```bash
emails inbound list                    # List received emails
emails inbound show <id>               # Show full details
emails inbound open <id>               # Open HTML in browser
emails inbound clear                   # Delete all received emails
emails inbound count                   # Show count
```

## Reliability

### Multi-provider failover

Configure one or more fallback providers. If the primary provider fails at send time, the CLI automatically retries each failover provider in order.

```bash
emails config set failover-providers <id1>,<id2>
```

The send command prints a warning when a failover is used:

```
⚠ Send failed on Resend Production, trying failover...
  (Used failover provider)
```

### Idempotency keys

Pass `--idempotency-key` to prevent duplicate sends. If an email with the same key was already sent, the existing record is returned instead of re-sending — safe to call repeatedly on retries.

```bash
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Order confirmed" --body "..." \
  --idempotency-key order-9876
```

## Deliverability

### List-Unsubscribe headers (RFC 8058)

Pass `--unsubscribe-url` to automatically inject `List-Unsubscribe` and `List-Unsubscribe-Post` headers conforming to RFC 8058 one-click unsubscribe — required by Gmail and Yahoo for bulk senders.

```bash
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Newsletter" --body "..." \
  --unsubscribe-url "https://yourdomain.com/unsubscribe?token=abc"
```

### Bounce and complaint alerts

Set thresholds (as percentages). After each `emails pull`, if the bounce or complaint rate for the last 30 days exceeds the threshold a warning is printed to stderr.

```bash
emails config set bounce-alert-threshold 5       # Alert when bounce rate > 5%
emails config set complaint-alert-threshold 0.1  # Alert when complaint rate > 0.1%
```

## CLI Reference

All commands support `--json` for machine-readable output, `-q` for quiet mode, and `-v` for verbose debug output.

### provider

Manage email providers.

```bash
emails provider add --name <name> --type <resend|ses|gmail|sandbox> [credentials...]
emails provider list
emails provider update <id> [--name <name>] [credentials...]
emails provider remove <id>
emails provider auth <id>          # Re-run OAuth flow (Gmail only)
emails provider status             # Health-check all active providers
```

### domain

Manage sending domains.

```bash
emails domain add <domain> --provider <id>
emails domain list [--provider <id>]
emails domain dns <domain>         # Show required DNS records
emails domain verify <domain>      # Re-check DNS verification status
emails domain status [--provider <id>]
emails domain remove <id>
```

### address

Manage sender email addresses.

```bash
emails address add <email> --provider <id> [--name "Display Name"]
emails address list [--provider <id>]
emails address verify <email>      # Check verification status
emails address remove <id>
```

### send

Send an email. Supports templates, groups, scheduling, attachments, failover, idempotency keys, and List-Unsubscribe headers.

```bash
emails send \
  --from hello@yourdomain.com \
  --to recipient@example.com \
  --subject "Subject line" \
  --body "Plain text body"

# HTML email
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Hello" --body "<h1>Hi</h1>" --html

# Send to a group
emails send --from hello@yourdomain.com --to-group newsletter \
  --subject "Weekly update" --body "..."

# Send using a template with variables
emails send --from hello@yourdomain.com --to user@example.com \
  --template welcome --vars '{"name":"Alice","link":"https://example.com"}'

# Schedule for later
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Scheduled" --body "Hi" --schedule "2025-06-01T09:00:00Z"

# With attachments
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Report" --body "See attached" --attachment report.pdf

# With List-Unsubscribe (RFC 8058)
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Newsletter" --body "..." \
  --unsubscribe-url "https://yourdomain.com/unsubscribe?token=abc"

# With idempotency key (safe to retry)
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Order confirmed" --body "..." \
  --idempotency-key order-9876

# Pipe body from stdin
cat message.txt | emails send --from hello@yourdomain.com --to user@example.com \
  --subject "From pipe"

# Override provider
emails send --from hello@yourdomain.com --to user@example.com \
  --subject "Test" --body "Hi" --provider <provider-id>
```

### batch

Send bulk emails to a list of recipients from a CSV file, using a template for the body.

```bash
emails batch \
  --from hello@yourdomain.com \
  --template welcome \
  --csv recipients.csv
```

The CSV must have an `email` column. Any additional columns are available as template variables (e.g. `{{name}}`).

```csv
email,name
alice@example.com,Alice
bob@example.com,Bob
```

### template

Manage reusable email templates. Subjects and bodies support `{{variable}}` placeholders.

```bash
emails template add welcome \
  --subject "Welcome, {{name}}!" \
  --html "<h1>Hi {{name}}</h1><p><a href='{{link}}'>Get started</a></p>" \
  --text "Hi {{name}}! Get started: {{link}}"

emails template list
emails template show <name>
emails template remove <name>
```

Load templates from files:

```bash
emails template add newsletter \
  --subject "{{title}}" \
  --html-file templates/newsletter.html \
  --text-file templates/newsletter.txt
```

### group

Manage recipient groups for bulk sending.

```bash
emails group create <name> [--description "..."]
emails group list
emails group show <name>
emails group add <name> <email> [--name "Display Name"] [--vars '{"k":"v"}']
emails group delete <name> <email>           # Remove a member
emails group delete <name>                   # Remove the group
```

Send to a group:

```bash
emails send --from hello@yourdomain.com --to-group newsletter \
  --subject "Weekly update" --template newsletter --vars '{}'
```

### sandbox

Inspect emails captured by sandbox providers (see [Sandbox Provider](#sandbox-provider-dev-mode)).

```bash
emails sandbox list [--provider <id>] [--limit <n>]
emails sandbox show <id>
emails sandbox open <id>
emails sandbox clear [--provider <id>]
emails sandbox count [--provider <id>]
```

### inbound

Receive and inspect inbound emails (see [Inbound Email](#inbound-email)).

```bash
emails inbound listen [--port 2525] [--provider <id>]
emails inbound list [--provider <id>] [--limit <n>]
emails inbound show <id>
emails inbound open <id>
emails inbound clear [--provider <id>]
emails inbound count [--provider <id>]
```

### log

View the sent email log.

```bash
emails log
emails log --provider <id>
emails log --limit 50
emails log --status delivered
emails log --from hello@yourdomain.com
```

### search

Full-text search across sent emails.

```bash
emails search "keyword"
emails search "alice" --provider <id> --limit 20
```

### test

Run a connectivity test against a provider.

```bash
emails test
emails test --provider <id>
```

### contacts

Manage the contact list. Suppressed contacts are skipped on send (unless `--force` is used).

```bash
emails contacts list
emails contacts list --suppressed       # Show only suppressed contacts
emails contacts suppress <email>
emails contacts unsuppress <email>
```

### scheduled

Manage scheduled emails.

```bash
emails scheduled list
emails scheduled list --status pending
emails scheduled cancel <id>
```

### scheduler

Run the background scheduler that sends due emails.

```bash
emails scheduler start                  # Start the scheduler daemon
emails scheduler run                    # Process due emails once and exit
```

### pull

Pull delivery events from a provider into the local database.

```bash
emails pull
emails pull --provider <id>
emails pull --since 2025-01-01
```

### stats

View delivery statistics.

```bash
emails stats
emails stats --provider <id>
emails stats --period 7d              # 1d, 7d, 30d, 90d
```

### analytics

Detailed analytics with ASCII charts: daily send volume, delivery and bounce trends, top recipients, and busiest hours.

```bash
emails analytics
emails analytics --provider <id>
emails analytics --period 30d         # 7d, 30d, 90d
```

### monitor

Live dashboard in the terminal (auto-refreshes).

```bash
emails monitor
emails monitor --provider <id>
emails monitor --interval 30          # Refresh interval in seconds
```

### doctor

Run diagnostics: checks provider connectivity, DNS configuration, database integrity, and scheduled-email backlog.

```bash
emails doctor
```

### completion

Generate shell completion scripts.

```bash
emails completion bash   >> ~/.bashrc
emails completion zsh    >> ~/.zshrc
emails completion fish   > ~/.config/fish/completions/emails.fish
```

### webhook

Start a local webhook server to receive delivery events from Resend or AWS SES.

```bash
emails webhook --port 3456
emails webhook --port 3456 --provider <id>
```

Expose the server with a tunnel (e.g. ngrok):

```bash
ngrok http 3456
# Then configure https://your-ngrok-url/webhook/resend in the Resend dashboard
# or  https://your-ngrok-url/webhook/ses   in the SNS subscription
```

Supported paths:
- `POST /webhook/resend` — Resend event payloads
- `POST /webhook/ses`    — AWS SNS notification payloads

### export

Export emails and events to CSV or JSON.

```bash
emails export emails --format csv --output emails.csv
emails export emails --format json --output emails.json
emails export events --format csv --output events.csv
emails export events --format json
```

### config

Manage CLI configuration stored at `~/.emails/config.json`.

```bash
emails config get default_provider
emails config set default_provider <provider-id>
emails config set failover-providers <id1>,<id2>
emails config set bounce-alert-threshold 5
emails config set complaint-alert-threshold 0.1
emails config list
```

## MCP Setup

Install the MCP server into Claude Code (or any MCP-compatible agent):

```bash
emails mcp --claude
```

This registers `emails-mcp` as a user-scoped MCP server in `~/.claude.json`.

For other agents:

```bash
emails mcp --codex
emails mcp --gemini
emails mcp --all
```

Available MCP tools:

| Tool | Description |
|------|-------------|
| `send_email` | Send an email (supports idempotency key, unsubscribe URL) |
| `list_emails` | List sent emails with filters |
| `search_emails` | Full-text search across sent emails |
| `list_providers` | List configured providers |
| `get_stats` | Delivery statistics for a provider |
| `get_analytics` | Detailed analytics with daily breakdown |
| `run_doctor` | Run system diagnostics |
| `pull_events` | Pull delivery events from a provider |
| `export_emails` | Export emails to CSV or JSON |
| `list_contacts` | List contacts and suppression status |
| `manage_templates` | Create, list, and remove templates |
| `list_sandbox_emails` | List emails captured by sandbox providers |
| `list_inbound_emails` | List received inbound emails |

## Dashboard

Start the web dashboard at `http://localhost:3000` (or a custom port):

```bash
emails serve
emails serve --port 8080
```

The dashboard shows real-time delivery metrics, recent emails, bounce rates, and provider health across all configured providers.

## Configuration

| File | Description |
|------|-------------|
| `~/.emails/config.json` | CLI configuration (default provider, failover providers, alert thresholds, log level) |
| `~/.emails/emails.db`   | SQLite database — all emails, events, contacts, templates, sandbox and inbound emails |

Override the database path:

```bash
EMAILS_DB_PATH=/path/to/custom.db emails send ...
# Use an in-memory database (for testing):
EMAILS_DB_PATH=:memory: emails ...
```

## Library Usage

`@hasna/emails` can also be imported as a library in your own Bun or Node project.

```typescript
import {
  getDatabase,
  createEmail,
  listEmails,
  searchEmails,
  upsertEvent,
  listEvents,
  createProvider,
  listProviders,
  getAdapter,
  parseResendWebhook,
  parseSesWebhook,
  createWebhookServer,
  getLocalStats,
  getAnalytics,
  batchSend,
} from "@hasna/emails";

// Get an adapter for a provider and send an email
const db = getDatabase();
const [provider] = listProviders(db).filter(p => p.active);
const adapter = getAdapter(provider);

const messageId = await adapter.sendEmail({
  from: "hello@yourdomain.com",
  to: "user@example.com",
  subject: "Hello",
  text: "Hello world",
  unsubscribe_url: "https://yourdomain.com/unsubscribe?token=abc",
  idempotency_key: "order-9876",
});

// Start a webhook server
const server = createWebhookServer(3456, provider.id);
// server.stop() when done

// Parse incoming webhook payloads yourself
const event = parseResendWebhook(incomingBody);
if (event) {
  upsertEvent({ provider_id: provider.id, ...event }, db);
}
```

## License

Apache-2.0 — © Andrei Hasna
