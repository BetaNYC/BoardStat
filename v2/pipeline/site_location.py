"""Where the live BoardStat site lives. Change it here, and only here (issue #118).

Used by the nightly publish job (boardstat_nightly.py) and the freshness check
(check/freshness.py). Standard library only: the freshness check runs on a bare
GitHub Actions runner.
"""

# Public address of the site, with the trailing slash.
SITE = "https://www.beta.nyc/boardstat/"
# The live manifest the nightly job and the freshness check read.
PUBLIC_MANIFEST = SITE + "data/manifest.json"
# The same folder on the DreamPress server, relative to the SSH user's home.
REMOTE_DIR = "beta.nyc/boardstat"
