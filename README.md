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
emails provider add-gmail   # requires: connectors auth gmail

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or configure DNS for an existing domain via Cloudflare
emails domain setup-cloudflare example.com --provider <id>

# Send an email
emails send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Sync Gmail inbox (full content — HTML + attachments)
emails inbox sync --all

# Check sent email log
emails email list

# Sync email data to RDS PostgreSQL
emails cloud push
```

## Command Structure

```
emails provider          # add/list/remove/sync providers (ses, resend, gmail)
emails domain            # add/verify/buy/setup/dns/check domains
emails address           # manage sender addresses
emails send              # send an email
emails email             # sent email: list, search, show, replies, thread
emails inbox             # inbound: sync (gmail/s3), list, read, reply, star, archive
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails triage            # AI triage: classify, prioritize, draft replies
emails cloud             # sync to/from cloud (RDS PostgreSQL): push, pull, migrate
emails aws               # AWS setup: SES receipt rules, S3 inbound bucket
emails config            # configuration (key=value)
emails stats             # delivery statistics (--inbox for received mail)
emails analytics         # email analytics
emails doctor            # system diagnostics
emails serve             # HTTP server + dashboard
emails mcp               # install MCP server
```

## MCP Server

91 tools available for AI agents.

```bash
emails-mcp
```

## REST API

```bash
emails-serve
```

## Inbound Email (AWS SES → S3)

```bash
# Set up S3 bucket + SES receipt rules
emails aws setup-inbound --domain example.com --bucket my-emails

# Sync received emails locally
emails inbox sync-s3 --bucket my-emails --prefix inbound/example.com/
```

## Cloud Sync (PostgreSQL)

```bash
# Configure RDS
emails cloud setup --host <rds-host> --username <user>

# Push local SQLite → RDS
emails cloud push

# Pull RDS → local
emails cloud pull
```

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## License

Apache-2.0 — see [LICENSE](LICENSE)
