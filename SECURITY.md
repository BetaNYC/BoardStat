# Browser security

Active dashboard pages use pinned CDN dependencies with integrity hashes,
jQuery 3.7.1, a meta Content Security Policy, and `no-referrer`. The CSP restricts
script sources and disallows inline scripts and eval. Inline styles are still
needed by the theme, maps, and charts. Dates are limited to 2010 through today.
The legacy `test.html` snapshot is unsupported and has no new CSP.

Google Analytics runs in `analytics.html`, which receives an allowlisted page
name with no parent referrer. It sends one explicit pageview using sanitized
page metadata. Dashboard filters, form fields, and history changes are not sent;
referral attribution and dashboard link/form measurement are disabled. Preview
hosts send no analytics. NYC Open Data receives filters as part of data queries.

The same-origin analytics frame limits normal measurement behavior; Google
remains a trusted dependency. Tests cover the local scripts, not future Google
tag behavior or property settings. Verify collection requests after deployment
as described in [DEPLOYMENT.md](DEPLOYMENT.md).

HSTS, `nosniff`, framing restrictions, and Permissions Policy still require
hosting configuration. Meta CSP cannot protect non-HTML responses or prevent
other sites from framing BoardStat. See the [deployment instructions](DEPLOYMENT.md)
for the remaining header work.
