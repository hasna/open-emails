# @hasna/emails

Email management CLI + MCP server + dashboard for Resend and AWS SES

[![npm](https://img.shields.io/npm/v/@hasna/emails)](https://www.npmjs.com/package/@hasna/emails)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/emails
```

## CLI Usage

```bash
emails --help
```

## MCP Server

```bash
emails-mcp
```

74 tools available.

## REST API

```bash
emails-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service emails
cloud sync pull --service emails
```

## Data Directory

Data is stored in `~/.hasna/emails/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
