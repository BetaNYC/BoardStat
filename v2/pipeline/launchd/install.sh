#!/bin/bash
# Install or update the BoardStat nightly launchd job on this Mac.
#   bash v2/pipeline/launchd/install.sh [DISCORD_CHANNEL]
# With no channel, failures go to the log only. Re-run any time; it reloads the job.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
NOTIFY="${1:-}"
DEST="$HOME/Library/LaunchAgents/nyc.betanyc.boardstat-nightly.plist"
mkdir -p "$HOME/Library/Logs/boardstat-nightly"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__NOTIFY__|$NOTIFY|g" \
  "$REPO/v2/pipeline/launchd/nyc.betanyc.boardstat-nightly.plist" > "$DEST"
plutil -lint "$DEST"
launchctl bootout "gui/$(id -u)" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed $DEST (alerts: ${NOTIFY:-log only}). Run now: launchctl kickstart gui/$(id -u)/nyc.betanyc.boardstat-nightly"
