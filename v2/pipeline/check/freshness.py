#!/usr/bin/env python3
"""Daily check that the live BoardStat data was rebuilt recently (issue #107).

The nightly job on the office Mac alerts on its own failures, but if the Mac is
off nothing runs and nothing alerts. This runs somewhere else (GitHub Actions),
reads the live manifest, and keeps one GitHub issue open while the data is stale:

- stale, no open issue  -> open one (repo watchers get notified)
- stale, issue open     -> add a dated comment
- fresh, issue open     -> comment and close it
- fresh, no issue       -> nothing

Uses only the standard library and the `gh` CLI (GH_TOKEN from the workflow).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from site_location import PUBLIC_MANIFEST as MANIFEST, SITE  # noqa: E402
MAX_AGE_H = float(os.environ.get("MAX_AGE_HOURS", "26"))
LABEL = "data-freshness"
TITLE = "BoardStat data is out of date"


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def check(now: dt.datetime) -> tuple[bool, str]:
    """(fresh, one-line reason)."""
    try:
        url = f"{MANIFEST}?check={int(now.timestamp())}"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BetaNYC-BoardStat-freshness"}), timeout=60) as r:
            m = json.load(r)
        built = dt.datetime.fromisoformat(m["generated_at"].replace("Z", "+00:00"))
    except Exception as exc:  # noqa: BLE001 - an unreadable manifest is itself a problem
        return False, f"Could not read {MANIFEST}: {exc}"
    age_h = (now - built).total_seconds() / 3600
    when = built.strftime("%Y-%m-%d %H:%M UTC")
    if age_h > MAX_AGE_H:
        return False, f"The live data was last built {when}, {age_h:.0f} hours ago (limit {MAX_AGE_H:.0f})."
    return True, f"The live data was built {when}, {age_h:.0f} hours ago."


def main() -> int:
    now = dt.datetime.now(dt.UTC)
    fresh, reason = check(now)
    print(reason)
    issues = json.loads(gh("issue", "list", "--label", LABEL, "--state", "open", "--json", "number"))
    today = now.strftime("%Y-%m-%d")
    if not fresh:
        if issues:
            gh("issue", "comment", str(issues[0]["number"]), "--body", f"Still out of date on {today}. {reason}")
        else:
            gh("label", "create", LABEL, "--color", "D93F0B", "--description", "Live BoardStat data is stale", "--force")
            body = (
                f"{reason}\n\n"
                "The nightly refresh runs at 5:30 AM on the office Mac mini (launchd job "
                "`nyc.betanyc.boardstat-nightly`). Likely causes: the Mac was off or asleep, "
                "the job failed (check Discord #ops-website), or NYC Open Data was down.\n\n"
                "**To check:** on the office Mac, read `~/Library/Logs/boardstat-nightly/` "
                "and run `launchctl print gui/$(id -u)/nyc.betanyc.boardstat-nightly`.\n"
                "**To run it now:** `launchctl kickstart gui/$(id -u)/nyc.betanyc.boardstat-nightly`.\n\n"
                f"Site: {SITE}. Setup and restart: `v2/README.md`, \"Nightly refresh\". "
                "This issue closes itself when the data is fresh again. Part of #107."
            )
            gh("issue", "create", "--title", TITLE, "--label", LABEL, "--body", body)
        return 0
    for i in issues:
        gh("issue", "comment", str(i["number"]), "--body", f"Fresh again on {today}. {reason} Closing.")
        gh("issue", "close", str(i["number"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
