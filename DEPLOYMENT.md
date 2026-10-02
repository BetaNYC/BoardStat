# GitHub Pages deployment

Production uses the root of the `gh-pages` branch. After an approved change is
merged into `master`, a maintainer can publish it with:

```bash
git fetch origin
git switch gh-pages
git merge --ff-only origin/master
git push origin gh-pages
```

Before pushing, confirm the intended commit is on `origin/master`, checks and
live validation pass, and `CNAME` still contains only `boardstat.beta.nyc`.
If the fast-forward fails, inspect the branch divergence; do not force-push.

Wait for the Pages build, then check the home page and all five borough routes
over HTTPS, including live totals, a map, a data table, and a narrow viewport.
To roll back, revert the change on `master` and deploy the reviewed revert using
the same procedure.

## Response headers

Active pages supply a meta CSP and `no-referrer` policy. GitHub Pages cannot set
arbitrary response headers from this repository. These headers need a hosting
layer that supports them:

```http
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

Check reliable HTTPS before enabling HSTS and correct script/style MIME types
before enabling `nosniff`. Do not add HSTS `includeSubDomains` or `preload`
without checking the wider domain deployment.

If external embedding is unnecessary, set `X-Frame-Options: SAMEORIGIN` and an
HTTP CSP with `frame-ancestors 'self'`. Otherwise use an approved origin list in
`frame-ancestors` and omit the conflicting X-Frame-Options policy. Same-origin
framing is needed for analytics. Meta CSP cannot enforce `frame-ancestors`.

After deployment, inspect actual response headers and Google collection requests.
Load a URL with address/complaint filters, then change filters: `page_location`/`dl`
must contain only the canonical page, the referrer must be empty, and only one
initial pageview should be sent. Preview hosts should send none. Repeat this
check after changing Google tags or analytics property settings.
