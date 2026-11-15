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
# The app token is required. If the lookup fails or is empty, never export an empty
# value: leave it unset and say so in the log. The nightly then stops before any
# network call and posts the failure through Rosie like any other failed night
# (boardstat_build.require_app_token), and the day's skip-if-published check still
# runs first. Stopping here instead would skip that alert.
SOCRATA_APP_TOKEN="$(kc boardstat-socrata-app-token)"
if [ -n "$SOCRATA_APP_TOKEN" ]; then
    export SOCRATA_APP_TOKEN
    token_missing=""
else
    unset SOCRATA_APP_TOKEN
    token_missing=1
fi
export DISCORD_TOKEN="$(kc boardstat-rosie-discord-token)"

# Discord channel for alerts; empty means alerts are only written to the log.
NOTIFY="${BOARDSTAT_NOTIFY:-}"
# Twice a day (5:30, and 8:30 as a retry): skip if today's run already published.
args=(--publish --skip-if-published-today)
[ -n "$NOTIFY" ] && args+=(--notify "$NOTIFY")

cd "$REPO"
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') start (branch $(git branch --show-current), commit $(git rev-parse --short HEAD))" >>"$LOG"
if [ -n "$token_missing" ]; then
    echo "=== STOP: Keychain item boardstat-socrata-app-token is missing or empty (or the login Keychain is locked); SOCRATA_APP_TOKEN is not set, so the nightly will refuse to run" >>"$LOG"
fi
set +e
uv run --quiet v2/pipeline/boardstat_nightly.py "${args[@]}" >>"$LOG" 2>&1
rc=$?
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') exit $rc" >>"$LOG"
exit $rc
