#!/bin/bash
# BoardStat nightly refresh, started by launchd (nyc.betanyc.boardstat-nightly).
# Runs outside Claude/T3: plain uv + Python. Setup and restart: v2/README.md, "Nightly refresh".
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/boardstat-nightly"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"

# Secrets live in the login Keychain, never in a file or this script.
kc() { security find-generic-password -s "$1" -w 2>/dev/null || true; }
export SOCRATA_APP_TOKEN="$(kc boardstat-socrata-app-token)"
export DISCORD_TOKEN="$(kc boardstat-rosie-discord-token)"

# Discord channel for alerts; empty means alerts are only written to the log.
NOTIFY="${BOARDSTAT_NOTIFY:-}"
# Twice a day (5:30, and 8:30 as a retry): skip if today's run already published.
args=(--publish --skip-if-published-today)
[ -n "$NOTIFY" ] && args+=(--notify "$NOTIFY")

cd "$REPO"
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') start (branch $(git branch --show-current), commit $(git rev-parse --short HEAD))" >>"$LOG"
set +e
uv run --quiet v2/pipeline/boardstat_nightly.py "${args[@]}" >>"$LOG" 2>&1
rc=$?
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') exit $rc" >>"$LOG"
exit $rc
