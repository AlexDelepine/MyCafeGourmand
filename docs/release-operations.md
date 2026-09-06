# Release operations

This document defines artifact, contact, redirect, and media verification
boundaries for the existing Azure Static Web Apps static-export architecture.
Azure resources and the external contact provider are not yet provisioned.
The owner-approved hosting design uses Azure Static Web Apps Free and generated
HTTP 200 legacy HTML navigation pages, not an edge provider or historical
HTTP 301 responses. Production remains blocked until the required content,
media/contact, hosting and live acceptance gates pass. The authoritative
deployment sequence and artifact separation are in [`deployment.md`](deployment.md).

## Artifact classes

### Local and CI artifacts

`npm run build:local` and `npm run build:ci` run the same credential-free static
build and write `out/`. They include sitemap, robots, localized routes, search
indexes, and generated Static Web Apps configuration, but they leave canonical
Blob media keys root-relative. They are useful for validation and preview and
must not be deployed.

Both commands reject `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL`. When
`NEXT_PUBLIC_CONTACT_FORM_ENDPOINT` is absent or invalid, they render an
explicit localized unavailable-contact boundary instead of a form.

Preview a completed local artifact with:

```sh
npm run build:local
npm run preview
```

This uses Python's static file server. The project intentionally has no
`next start` command.

### Release artifacts

The only production artifact command is:

```sh
export NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL="https://<approved-media-host>/<container>"
export NEXT_PUBLIC_CONTACT_FORM_ENDPOINT="https://<approved-contact-host>/<public-submit-path>"
npm run build:release
```

`build:release` rejects invalid public values and performs pre-build and output
validation, including complete generated legacy-page coverage. A successful
local release build is not approval to deploy and does not prove live Azure
path behavior. The canonical site origin must remain
`https://mycafegourmand.com`. The media base must be absolute HTTPS with no
credentials, query, or fragment. It may be a validated Blob or CDN/custom-domain
base after that external infrastructure exists.

The media output validator scans bounded deployable artifacts, including
HTML, CSS, JavaScript, React Flight/RSC text, and JSON-LD. It rejects:

- root-relative manifest-backed media;
- media keys absent from the appropriate public manifest;
- a different origin or base path;
- managed-media URLs that do not resolve exactly from the configured HTTPS base.

The same command checks static route/file coverage and output size limits.
Contact endpoint configuration is validated before the build, not by this
media output scan. Neither validator proves provider approval, successful
contact delivery, or correct live deployment.

Never deploy the output of `build`, `build:static`, `build:local`, or
`build:ci`.

## Contact form adapter contract

The static localized contact pages submit
`application/x-www-form-urlencoded` directly to
`NEXT_PUBLIC_CONTACT_FORM_ENDPOINT`. The endpoint is public build
configuration, not a secret. It must not contain a recipient address,
credential, token, URL credential, fragment, private/loopback host, or the
site's own host or subdomain.

The parser checks HTTPS syntax, URL credentials/fragments, same-site targets,
and lexical host restrictions. It does not resolve DNS, recognize every secret
embedded in a path/query, or establish provider approval. The pre-build contact
check logs the endpoint, so the operator must verify it is safe public
configuration before setting it.

The external adapter must accept only:

| Field | Contract |
| --- | --- |
| `name` | Required text, at most 120 characters |
| `email` | Required email text, at most 254 characters |
| `subject` | Optional text, at most 200 characters |
| `message` | Required text, at most 5,000 characters |
| `locale` | Exactly `en`, `fr`, or `ru` |
| `returnUrl` | One app-generated absolute canonical success URL |
| `website` | Honeypot; a nonempty value may be rejected and is not contact data |

The adapter must independently enforce bounds and allow-list the exact absolute
return URLs at the site's canonical origin with paths `/contact/success/`,
`/fr/contact/success/`, and `/ru/contact/success/`. A matching path at another
origin is not allowed. It may redirect only after accepting the submission.
The confirmation pages are canonical noindex routes excluded from the sitemap.

Launch remains blocked until the owner approves an accurate privacy notice for
the selected provider and its real data flow, retention, deletion, and contact
practices. Do not restore the obsolete WordPress privacy text.

## Historical URL navigation

Builds validate every recipe and editorial `redirectFrom` path, generate a
static HTML navigation page at its supported output path, and write
`.deployment/redirect-manifest.json`. The version-2 metadata explicitly records
`mechanism: "html-refresh"` and source/destination pairs, not HTTP 301 statuses.
It stays outside the public `out/` artifact. Sources are root-relative local
paths without queries or fragments. Destinations are matching canonical locale
paths with static-export trailing slashes.

Each legacy page has an immediate meta refresh, matching canonical URL and
localized fallback link, with no JavaScript requirement. It returns HTTP 200.
Google recognizes immediate refresh as a permanent signal, but server-side
redirects are preferable when available and non-browser clients may not follow
HTML refresh. The owner accepted this tradeoff for simpler Azure-only hosting.
Do not silently substitute JavaScript-only redirects or claim HTTP 301 behavior.

The separate `out/staticwebapp.config.json` is limited to 20,000 UTF-8 bytes and
contains the origin trailing-slash policy and baseline headers, not the
historical navigation catalog. See [`deployment.md`](deployment.md) for the
manifest shape, safe legacy output generation, stale-output handling and
staging-only submission policy.

Keep unrelated hand-authored Azure routes, headers, and fallback settings in
`config/staticwebapp.config.json`. Never place a hand-authored copy in
`public/`. The generator merges both sources and rejects:

- duplicate redirect sources;
- canonical-route sources;
- conflicts between generated and hand-authored routes;
- redirect cycles;
- wildcard redirect routes whose cycles cannot be proven statically.

The migration preserves old-link navigation only for published source permalinks,
safe `_wp_old_slug` values on the same source parent, and enabled exact
Redirection URL/301 rows that terminate at promoted content. The latter describes
the source evidence, not the new site's HTTP response status. It does not
promise taxonomy, feed, attachment, print, shortlink, or arbitrary WordPress
compatibility.

## Media upload boundary

The authenticated media-plan commands in
[`migration-operations.md`](migration-operations.md) create private exact
object trees. They do not contact Azure and accept no Azure credentials,
account, container, or destination.

External provisioning and upload are separate, interactively authenticated
operator actions. Use only real, approved values in the operator shell. The
storage/CDN configuration must provide:

- HTTPS-only delivery;
- public anonymous read of individual objects, not container listing;
- production-origin `GET` and `HEAD` CORS rather than a wildcard;
- the manifest-normalized MIME type for every object;
- the approved immutable cache policy;
- no overwrite of an existing object during a resumed upload.

Do not infer success from an upload command or provider metadata. Skipped
objects and retries must be reconciled with the repository verifier.

## Post-upload verification

Verify recipe and editorial/gallery plans together so duplicate object keys are
also rejected:

```sh
npm run media:verify-azure -- \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --container "$AZURE_STORAGE_CONTAINER" \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --upload-dir migration-output/editorial-media-azure-v4
```

The verifier constructs the bounded HTTPS URL and streams every expected
object. It requires:

- the exact requested origin and path with no redirect;
- status `200`;
- the upload plan's normalized `Content-Type`;
- expected `Content-Length` and exact streamed byte count;
- exact manifest SHA-256.

It does not trust caller-supplied object metadata or an Azure CLI property
lookup. It prints aggregate results only. Do not delete either private object
tree until combined verification succeeds.

## Release gate

Before a production artifact can be considered deployable:

1. `npm run check` and `npm run build:ci` pass on the reviewed commit.
2. Both media upload plans match their authenticated source and public
   manifests.
3. Combined remote media verification succeeds.
4. The owner approves the real media origin, contact endpoint, and privacy
   notice.
5. Every historical mapping has a validated generated HTML navigation page;
   `npm run build:release` succeeds with those exact public values.
6. The production `out/` passes the release output validator. Its staged variant
   passes every live old-path/encoding/navigation check with noindex and
   technically blocked ordinary form submissions. Promote the retained
   production artifact without rebuilding or copying staging-only response
   restrictions. Never copy `.deployment/` into the public upload tree.
7. Inspect the rendered contact form actions in all locales and test acceptance,
   rejection, delivery, and return redirects against the approved provider.

No repository document or credential-free CI run proves that external Azure,
DNS, TLS, CORS, contact, or GitHub settings are configured.
