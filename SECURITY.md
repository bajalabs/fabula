# Security

## Reporting a vulnerability

Please report a vulnerability privately, through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/bajalabs/fabula/security/advisories/new). Do not open a
public issue. Say what you found, how to reproduce it (a request body is ideal), and what it lets an attacker do. We
aim to answer within five working days and to publish a fix with an advisory once it is released.

Supported versions: the latest release. A fix is released as a new version, not backported.

## The model

Fabula renders documents for callers that hold a key. It assumes:

- **The operator** controls the deployment: the environment, the named templates (`FABULA_TEMPLATES_DIR`), the
  network the container sits on.
- **A caller** is trusted to choose what to render and, unless `FABULA_ALLOW_INLINE_SOURCE=false`, to send a
  template's source. A source is code for an engine.
- **Values** (the data a template is filled with) are untrusted: they may come from a caller's own users.
- **Brand files and pictures** are untrusted bytes from an allowed host.

### Callers

Every route but `/health`, `/healthz` and `/readyz` needs a known caller.

- `FABULA_AUTH=hmac` (default): `x-fabula-caller` and `x-fabula-signature: t=<unix s>,v1=<hex>`, HMAC-SHA256 with the
  caller's key over `<caller>.<t>.<METHOD>.<path?query>.<raw body>`. The time must be within 60 seconds; the
  comparison is constant-time; a POST, PUT, PATCH or DELETE signature is accepted once per process; a write whose raw
  body did not reach the guard is refused. Keys are hex, at least 128 bits, checked at boot.
- `FABULA_AUTH=token`: `Authorization: Bearer <token>`, compared by SHA-256 digest in constant time. A token is the
  whole secret and travels with every request: use it only over TLS.
- Callbacks from Fabula are signed the same way, as caller `fabula`, with `FABULA_CALLBACK_KEY`, and go only to
  `FABULA_CALLBACK_HOSTS`, following no redirect.
- Logs redact the signature and authorization headers; no key or token is ever logged.

### Values never become code

Every value is checked against its field's type before any engine runs (a 400 names the field):

- Text reaches Typst, and Pandoc's and Quarto's PDFs, as a Typst string literal (quote, backslash and line breaks
  escaped, `{` written `\u{7b}` so Quarto never sees a `{{< shortcode >}}`); lists and objects as Typst literals
  whose keys are strings.
- Text reaches HTML, MJML and Chromium HTML-escaped; a list or an object in a `{{ key }}` is refused; a template's
  `{{ key }}` must be one of its declared fields.
- A value no field declares (in a request with its own source) must be text, a number or true/false.
- Brand strings reach Typst as string literals, CSS as escaped CSS strings, MJML as escaped attributes, Quarto's
  `_brand.yml` without braces.

### What a source can reach

| Engine | Files | Network |
|---|---|---|
| Typst | its render folder only (`--root`) | none: no package download (the cache is read-only and the proxy answers nothing) |
| Pandoc | the files on its command line only (`--sandbox`); its PDF's Typst as above | none |
| Quarto | **any file the service user can read**, through an image path or an include | none (proxy) |
| WeasyPrint | `data:` URLs and its render folder only (a URL fetcher in `scripts/weasyprint-render.py`) | none |
| MJML | none (`<mj-include>` is not read) | none |
| Chromium | its render folder only, served by Fabula over the DevTools protocol; scripts off | none (every request is intercepted; a dead proxy and resolver stand behind) |

Quarto is a document system that trusts its documents. Fabula refuses a Quarto source whose front matter loads code
or files (`filters`, `shortcodes`, `engine`, `execute`, `include-*`, `metadata-files`, `template-partials` and
others, at any depth) or that uses a shortcode other than `pagebreak`, `meta`, `var`, `kbd`, `lipsum` and
`placeholder`, and never runs a code cell. That narrows what a source can do; it does not confine Quarto's reads.
**If callers who send sources are not fully trusted, set `FABULA_ALLOW_INLINE_SOURCE=false` (named templates only)
or leave `quarto` out of `FABULA_ENGINES`.** With named templates only, values are the only input, and they cannot
reach a file.

Every engine process runs with a stripped environment: the service's keys and tokens are not in it.

### Limits

`FABULA_BODY_LIMIT_BYTES` (8 MiB), `FABULA_MAX_CONCURRENT_RENDERS` (6), `FABULA_RENDER_TIMEOUT_SECONDS` (60, per
engine process; the process is killed), `FABULA_ASSET_MAX_BYTES` (10 MiB, enforced while streaming),
`FABULA_ASSET_TIMEOUT_SECONDS` (15), `FABULA_IMAGE_MAX_PIXELS` (40 million, read from the file's header the way its
decoder will read it: a JPEG walked through its scans, a WebP's canvas and bitstream both, a PNG's IHDR),
`FABULA_ASSET_CACHE_MAX_BYTES` (512 MiB), a list or object field at most 32 levels deep and 1,000 items. An SVG logo
with a DOCTYPE or an entity is refused.

### Files from outside

Brand fonts and logos and document pictures are fetched only over https, only from a host on `FABULA_ASSET_HOSTS`
(exact name or `*.example.com`, port included), with no redirect, within the size and time limits, and are used only
when the sha256 of their bytes matches the one in the request. An error names the file by its role and its host,
never its path or query string. The cache is content-addressed and the file is hashed again where a render uses it.

### The network

Engine processes get a proxy that answers nothing, which holds every tool that honours proxy variables; WeasyPrint's
fetcher and Chromium's interception do not depend on it. For a guarantee, put the container on a network with no way
out when it fetches no brand files and makes no callbacks (`compose.yaml` shows how), or allow egress only to the
hosts on `FABULA_ASSET_HOSTS` and `FABULA_CALLBACK_HOSTS`.

### The container

The image runs as the unprivileged `node` user with `/app` read-only to it. `compose.yaml` adds a read-only root
file system (only `/tmp` and the user's home are writable, as tmpfs), drops every capability, forbids new
privileges, and caps processes and memory. Chromium runs with `--no-sandbox`: its own sandbox needs privileges a
container does not give, so the container is the boundary; scripts are off and the page can load nothing but the
render's files.

### Known limits

- The replay guard is per process: behind several replicas without sticky routing, a captured signature could be
  replayed once on another replica within its 60 seconds.
- Quarto's reads are not confined (above).
- Fabula does not scan fonts or images for malformed content beyond their headers; the engines parse them.
