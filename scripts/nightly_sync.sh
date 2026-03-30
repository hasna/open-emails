#!/usr/bin/env bash
set -euo pipefail

REPO="/home/hasna/workspace/hasna/opensource/opensourcedev/open-emails"
LOG="$HOME/.hasna/emails/nightly-sync.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cd "$REPO"
log "=== nightly sync start ==="

# 1. Commit any uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  # Secrets scan before committing
  if git diff --cached --diff-filter=ACM -- '*.env' '*.json' '*.toml' '*.ts' '*.js' '*.md' '*.sh' '*.yml' '*.yaml' \
      | grep -qiE 'sk-ant-|sk-proj-|npm_[a-zA-Z]|gho_|ghp_|secret-token:|ctx7sk-|xai-|AIza[a-zA-Z0-9]|AKIA[A-Z0-9]'; then
    log "ERROR: secrets detected in staged files — skipping commit"
    exit 1
  fi
  git add -A
  git commit -m "chore: nightly auto-commit $(date '+%Y-%m-%d')" || true
  log "committed uncommitted changes"
else
  log "nothing to commit"
fi

# 2. Pull latest from GitHub
log "pulling from origin/main..."
git pull origin main 2>&1 | tee -a "$LOG"

# 3. Install deps if package.json changed
if git diff HEAD~1 --name-only 2>/dev/null | grep -q "package.json"; then
  log "package.json changed — running bun install..."
  bun install 2>&1 | tee -a "$LOG"
fi

log "=== nightly sync done ==="
