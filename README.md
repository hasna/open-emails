# @hasna/emails

Email management CLI + MCP server — send, receive, sync, and manage email via Resend, AWS SES, and Gmail.

[![npm](https://img.shields.io/npm/v/@hasna/emails)](https://www.npmjs.com/package/@hasna/emails)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/emails
```

## Quick Start

```bash
# Add a provider (SES, Resend, or Gmail)
emails provider add --type ses --region us-east-1 --access-key ... --secret-key ...
emails provider add-gmail   # from connect-gmail auth

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or just configure DNS for an existing domain
emails domain setup-cloudflare example.com --provider <id>

# Send an email
emails send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Sync Gmail inbox
emails inbox sync --all

# Check sent email log
emails email list
```

## Command Structure

```
emails provider          # add/list/remove/sync providers (ses, resend, gmail)
emails domain            # add/verify/buy/setup domains
emails address           # manage sender addresses
emails send              # send an email
emails email             # sent email: list, search, show, replies, thread
emails inbox             # inbound email: sync (gmail/s3), list, read, reply
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails triage            # AI triage: classify, prioritize, draft replies
emails config            # configuration
emails doctor            # system diagnostics
emails stats             # delivery statistics
emails analytics         # email analytics
emails serve             # HTTP server + dashboard
emails mcp               # install MCP server
```

## MCP Server

84 tools available for AI agents.

```bash
emails-mcp
```

## REST API

```bash
emails-serve
```

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## License

Apache-2.0 — see [LICENSE](LICENSE)
