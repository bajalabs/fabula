# Fabula

[![CI](https://github.com/bajalabs/fabula/actions/workflows/ci.yml/badge.svg)](https://github.com/bajalabs/fabula/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/bajalabs/fabula?sort=semver)](https://github.com/bajalabs/fabula/releases)

Fabula is a self-hostable HTTP service that turns a template plus data into a PDF, an HTML page, an email, a Word or PowerPoint file, or an image, for developers who want one signed endpoint in front of Typst, Pandoc, Quarto, WeasyPrint, MJML and Chromium instead of six tools in every app.

It is stateless: no database, no queue, no account. A request carries a template's name (or its own source), the values, and optionally a brand (colours, fonts, logos, legal text); the answer carries the document. Every value is checked against its field's type before an engine sees it, and every engine runs confined to its own folder, with no network.

## Quick start

With Docker (the image carries every engine; the first build takes a few minutes):

```sh
git clone https://github.com/bajalabs/fabula.git && cd fabula
export FABULA_KEY=$(openssl rand -hex 32)
export FABULA_HMAC_KEYS="{\"me\":\"$FABULA_KEY\"}"
docker compose up --build -d
until curl -fs localhost:3100/readyz; do sleep 2; done
node scripts/fabula.mjs render one-pager@1 --out one-pager.pdf
```

`scripts/fabula.mjs` signs the request with `FABULA_KEY` as caller `me` and renders the template's own sample; pass a JSON file of values after the template's name to render your own. `node scripts/fabula.mjs templates` lists what is there.

Without Docker (Node 24 and pnpm 10; the engines you want on your `PATH`, see [Engines](#engines); MJML needs nothing):

```sh
pnpm install
pnpm build
export FABULA_KEY=$(openssl rand -hex 32)
FABULA_HMAC_KEYS="{\"me\":\"$FABULA_KEY\"}" FABULA_REQUIRE_ENGINES=false pnpm start &
until curl -fs localhost:3100/healthz; do sleep 1; done
node scripts/fabula.mjs render announcement@1 --out announcement.html
```

`pnpm start` and `pnpm dev` (rebuilds and restarts on change) also read a `.env` file; `.env.example` lists every variable.

## What is inside

| | |
|---|---|
| Engines | 6: Typst, Pandoc, Quarto, WeasyPrint, MJML, Chromium |
| Outputs | PDF (tagged by default; PDF/UA-1 and PDF/A where the engine can), HTML, email HTML, `.docx`, `.pptx`, PNG, JPEG, and a PNG of every page of a PDF |
| Example templates | 7, one or more per engine: `one-pager@1`, `checklist@1` (Typst), `memo@1` (Pandoc), `brief@1` (Quarto), `certificate@1` (WeasyPrint), `social-card@1` (Chromium), `announcement@1` (MJML) |
| Field types | 11: `string`, `number`, `integer`, `money_cents`, `boolean`, `date`, `enum`, `array`, `object`, `sections`, `contact` |
| Tests | 25 spec files, 294 tests (Vitest); 14 of them compile with Typst and the Chromium ones drive a real browser, so they run where those binaries are installed, as in CI |
| Code | TypeScript on NestJS 11 and Fastify 5, Node 24, no database |

```
src/
  auth/        request signatures, bearer tokens, the guard
  config/      the environment, validated at boot, and the runtime settings
  contracts/   the request and response schemas (zod), shared with clients
  health/      /health, /healthz, /readyz and the engine preflight
  render/      the controller, the orchestrator, templates, field values, callbacks, previews
    brand/     the brand in each engine's terms, and the fetched brand files and pictures
    engines/   one file per engine, and the confined subprocess environment
  util/        Typst literals, {{ key }} substitution, image headers, contrast
templates/     <kind>/<name>/v<version>/template.json + the template's source
scripts/       the client (fabula.mjs), the WeasyPrint wrapper, the Office theme writer, the engine drill
test/          the specs
```

## Engines

| Engine | `format` | Outputs | Values reach the template as | Confinement |
|---|---|---|---|---|
| [Typst](https://typst.app) 0.15.1 | `typst` | `pdf` | `#let key = <literal>` lines before the source | reads only its render folder (`--root`) |
| [Pandoc](https://pandoc.org) 3.13 | `markdown` | `pdf` (through Typst), `html`, `docx`, `pptx` | the same `#let` lines in a raw Typst block (PDF only) | `--sandbox`: reads only the files on its command line |
| Pandoc | `docx` | `pdf`, `html` | (a finished `.docx`, base64, read back) | as above |
| [Quarto](https://quarto.org) 1.11.9 | `quarto` | `pdf` (through Typst), `html` | the same `#let` lines in a raw Typst block (PDF only) | never runs code; front matter that loads code or files, and file-reading shortcodes, are refused (not a sandbox, see [Security](#security)) |
| [WeasyPrint](https://weasyprint.org) 70.0 | `html` | `pdf` | `{{ key }}`, HTML-escaped | a URL fetcher that reads only `data:` URLs and its render folder |
| [MJML](https://mjml.io) 5 | `mjml` | `html` | `{{ key }}`, HTML-escaped | no `<mj-include>` |
| Chromium (headless) | `html` | `png`, `jpeg`, `pdf` with `"engineConfig": {"engine": "chromium"}` | `{{ key }}`, HTML-escaped | scripts off; every request answered by Fabula from its render folder, nothing else |

Every engine process runs with a stripped environment (no key of the service) and a proxy that answers nothing, under `FABULA_RENDER_TIMEOUT_SECONDS`. HTML to PDF is WeasyPrint's unless the request asks for Chromium; HTML to PNG or JPEG is Chromium's.

## API

Every route but the three health routes needs a caller (see [Signing a request](#signing-a-request)). Bodies are JSON; `bytes` in an answer is base64.

| Method and path | What it does |
|---|---|
| `GET /health` | Each enabled engine and its version (`null` when its binary is missing), `status` (`ready` or `degraded`), uptime. Public. |
| `GET /healthz` | Liveness: 200 while the process answers. Public. |
| `GET /readyz` | Readiness: 200 once every enabled engine was found (with `FABULA_REQUIRE_ENGINES=true`), else 503. Public. |
| `GET /templates` | The templates this instance serves: id, format, output, fields with their types, a sample. |
| `POST /render` | Render a template by name, or a source of the request's own. With `callback`, answers 202 and POSTs the result later. |
| `POST /preview` | The same render, never with a callback. |
| `POST /data/parse` | CSV, JSON, YAML or TOML text to records. |
| `POST /data/validate` | Values against a list of fields, by the same types a render checks; answers the issues and the coerced values. |

### `POST /render`

```jsonc
{
  "template": "one-pager@1",           // or "format" + "source", never both
  "values": { "title": "Hello" },      // checked against the template's fields
  "output": "pdf",                     // optional: the template's own output by default
  "brand": {                           // optional
    "displayName": "Acme", "primaryColor": "#0E7C66", "fontBody": "Noto Sans",
    "colors": [{ "token": "accent", "hex": "#C5973B" }],
    "fonts":  [{ "role": "heading", "family": "Inter", "weight": 700, "format": "ttf", "url": "https://files.example.com/inter.ttf", "sha256": "<64 hex>" }],
    "logos":  [{ "variant": "primary", "mode": "light", "format": "svg", "url": "https://files.example.com/logo.svg", "sha256": "<64 hex>" }],
    "legal":  [{ "market": "US", "locale": "en-US", "kind": "footer", "markdown": "Acme Bakery LLC" }]
  },
  "engineConfig": { "pdf": { "standards": ["ua-1"] } },   // optional, per engine
  "previews": { "ppi": 110, "maxPages": 20 },             // optional: a PNG of every page of a PDF
  "callback": { "url": "https://jobs.example.com/fabula", "id": "job-42" },  // optional
  "meta": { "requestId": "r-1" }                          // optional, echoed in the logs
}
```

A request with its own source names `format`, gives `source`, and declares its `fields` (`{ "key", "label", "fieldTypeKey" }`); a value no field declares must be text, a number or true/false. Brand files are fetched only from `FABULA_ASSET_HOSTS`, over https, without redirects, and must match their `sha256`.

Answers:

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "mime": "application/pdf", "bytes": "<base64>", "durationMs": 812, "warnings": [...], "pages": [...], "pageCount": 1 }` |
| 202 | `{ "accepted": true, "jobId": "job-42" }` (with `callback`) |
| 400 | `{ "error": "validation_failed", "issues": [{ "path": ["title"], "message": "...", "code": "..." }] }`: the body or a value does not fit |
| 401 | `{ "error": { "code": "invalid_signature", "message": "..." } }`, or `missing_caller`, `unknown_caller`, `stale_signature`, `replayed_signature`, `missing_token`, `invalid_token` |
| 403 | `{ "error": "inline_source_disabled" }` with `FABULA_ALLOW_INLINE_SOURCE=false` |
| 422 | `{ "ok": false, "errors": [{ "severity": "error", "message": "...", "file": "main.typ", "line": 3, "column": 5 }] }`: the render failed (a compile error names the template's own file and line) |
| 429 | `{ "error": "too_many_renders" }` above `FABULA_MAX_CONCURRENT_RENDERS` |
| 503 | `{ "error": "shutting_down" }` while the service drains |

A callback is POSTed to `callback.url` (whose host must be on `FABULA_CALLBACK_HOSTS`) as `{ "jobId", "event": "render.completed" | "render.failed", "result": <the 200 or 422 body> }`, signed as caller `fabula` with `FABULA_CALLBACK_KEY` in the same scheme as requests; three attempts (0 s, 2 s, 8 s), no redirect followed.

### Signing a request

With `FABULA_AUTH=hmac` (the default) a caller sends two headers:

```
x-fabula-caller:    <caller>                      a key of FABULA_HMAC_KEYS
x-fabula-signature: t=<unix seconds>,v1=<hex>     HMAC-SHA256, the caller's key decoded from hex,
                                                  over "<caller>.<t>.<METHOD>.<path?query>.<raw body>"
```

The time must be within 60 seconds of the server's, and a POST signature is accepted once. With curl and openssl:

```sh
body='{"template":"announcement@1","values":{"heading":"Hello","body":"Signed with openssl"}}'
t=$(date +%s)
sig=$(printf '%s' "me.$t.POST./render.$body" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$FABULA_KEY" | sed 's/^.* //')
curl -s localhost:3100/render -H 'content-type: application/json' \
  -H 'x-fabula-caller: me' -H "x-fabula-signature: t=$t,v1=$sig" -d "$body"
```

A fixed vector to check a client against: key `000102…1e1f` (the 32 bytes 0 to 31), caller `reports`, `t=1793491200`, `GET /templates` with an empty body gives `v1=11d457d465ebabd0dfd1655580043f4a4e48a7669cc9006c3b806a045c983215`.

With `FABULA_AUTH=token` a caller sends `Authorization: Bearer <token>`, one of `FABULA_TOKENS`:

```sh
curl -s localhost:3100/render -H "authorization: Bearer $FABULA_TOKEN" -H 'content-type: application/json' \
  -d '{"format":"typst","source":"= Hello\nFrom an inline source.","output":"pdf"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(JSON.parse(s).bytes,"base64")))' > hello.pdf
```

### Templates

A template is a folder `templates/<kind>/<name>/v<version>/` with a `template.json` and its entry file, called as `<name>@<version>`. A new version is a new folder; a request never gets a version it did not name. The manifest:

```jsonc
{
  "name": "memo", "kind": "report", "version": 1, "title": "Memo",
  "format": "markdown", "output": "pdf", "entry": "main.md",
  "fields": [
    { "key": "title", "label": "Title", "fieldTypeKey": "string", "isRequired": true },
    { "key": "summary", "label": "Summary", "fieldTypeKey": "string", "maxLength": 2000 },
    { "key": "highlights", "label": "Highlights", "fieldTypeKey": "array", "defaultValue": [] }
  ],
  "engineConfig": {},
  "sample": { "title": "Quarterly kitchen review", "summary": "…", "highlights": ["…"] }
}
```

Templates are read once at boot from `FABULA_TEMPLATES_DIR`; a manifest that does not parse, a field type Fabula does not know, or an HTML or MJML `{{ key }}` that is not a declared field stops the boot with the path named. Typst templates import `_shared/brand.typ` for the brand (`brand-primary`, `font-body`, `brand-logo(...)`, `brand-legal`, …); HTML templates use the brand's CSS variables (`--brand-primary`, `--font-body`, `.brand-logo`).

## Configuration

Every setting is an environment variable; an empty one counts as unset. The service refuses to start with a missing or malformed one and names it.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3100`, `0.0.0.0` | Where the service listens. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn` or `error`; logs are JSON lines, signatures and tokens redacted. |
| `FABULA_AUTH` | `hmac` | `hmac` (signed requests) or `token` (bearer tokens). |
| `FABULA_HMAC_KEYS` | (required with `hmac`) | JSON object, caller name to hex key of at least 32 hex characters. |
| `FABULA_TOKENS` | (required with `token`) | JSON object, caller name to token of 32 to 512 printable characters. |
| `FABULA_ASSET_HOSTS` | (none: nothing is fetched) | Comma-separated hosts brand files and pictures may come from: `files.example.com`, `*.example.com` (names under it), `:port` when not 443. |
| `FABULA_CALLBACK_KEY` | (none: callbacks refused) | 64 hex characters; the key callbacks are signed with. |
| `FABULA_CALLBACK_HOSTS` | (none: callbacks refused) | Comma-separated `host` or `host:port` a callback may go to. |
| `FABULA_BODY_LIMIT_BYTES` | `8388608` (8 MiB) | Largest request body. |
| `FABULA_MAX_CONCURRENT_RENDERS` | `6` | Renders at once per process; above it, 429. |
| `FABULA_RENDER_TIMEOUT_SECONDS` | `60` | Longest run of one engine process (and of the page previews). |
| `FABULA_ASSET_MAX_BYTES` | `10485760` (10 MiB) | Largest brand file or picture. |
| `FABULA_ASSET_TIMEOUT_SECONDS` | `15` | Longest fetch of one brand file or picture. |
| `FABULA_IMAGE_MAX_PIXELS` | `40000000` | Most pixels a picture, a raster logo or a screenshot may have, by its header. |
| `FABULA_ASSET_CACHE_DIR` | `<system temp>/fabula-assets` | Content-addressed cache of fetched files. |
| `FABULA_ASSET_CACHE_MAX_BYTES` | `536870912` (512 MiB) | Past it, the files used longest ago leave the cache. |
| `FABULA_TEMPLATES_DIR` | `./templates` | Where the named templates are. |
| `FABULA_ENGINES` | all six | Comma-separated engines this instance runs: `typst,pandoc,quarto,weasyprint,mjml,chromium`. |
| `FABULA_ALLOW_INLINE_SOURCE` | `true` | `false`: only named templates render; a request with its own source is a 403. |
| `FABULA_CHROMIUM_PATH` | `chromium` (`/usr/bin/chromium` in the image) | The Chromium binary. |
| `FABULA_REQUIRE_ENGINES` | `true` | With `true`, `/readyz` answers 503 while an enabled engine's binary is missing. |
| `FABULA_DRAIN_SECONDS` | `30` | On SIGTERM, how long renders in flight may finish. |
| `TYPST_PACKAGE_CACHE_PATH` | (set in the image) | Typst's package cache; the image holds `cetz` and `fletcher`, and a render never downloads one. |

Render folders live under the system temp folder (`TMPDIR`). One instance keeps its replay guard in memory: behind several replicas, a replayed signature could reach another replica within its 60 seconds.

## Security

The short version; [SECURITY.md](SECURITY.md) has the model in full and how to report a problem.

- **Callers.** Every route but the health probes needs a known caller: a request signed with its own key (HMAC-SHA256 over the method, path, query and exact body, within 60 seconds, a write accepted once) or a bearer token. The keys are checked at boot and never logged.
- **Values are data, never code.** Every value is checked against its field's type before an engine runs (400 otherwise). Text becomes a Typst string literal or HTML-escaped text; a list or an object reaches Typst as a literal whose keys are strings, and is refused in HTML. No value can open a Quarto shortcode.
- **Sources are trusted.** A named template comes from the operator. A source sent in a request comes from a caller who holds a key, and the engines confine what it reaches where they can (the table in [Engines](#engines)), but Quarto can read any file the service can. Where callers are not fully trusted, set `FABULA_ALLOW_INLINE_SOURCE=false`, or leave `quarto` out of `FABULA_ENGINES`.
- **Limits.** Body size, renders at once, a deadline per engine process, the size and fetch time of each file, the pixels of each picture (read from the header, as the decoder will read it), the cache's size.
- **Files from outside.** Brand files and pictures are fetched only over https, only from `FABULA_ASSET_HOSTS`, without redirects, within size and time limits, and only when their sha256 matches.
- **No network from templates.** Engine processes get a proxy that answers nothing; WeasyPrint's fetcher and Chromium's request interception allow only the render's own files. For a hard guarantee, run the container on a network with no way out (`compose.yaml` shows how).
- **The container.** Runs as an unprivileged user, read-only but for `/tmp` and the user's home, no capabilities, no new privileges (`compose.yaml`). Chromium runs without its own sandbox, which needs privileges a container does not give; scripts are off and it can load nothing but the render's files.

## How it is built

The image (`Dockerfile`) installs each engine from its own release, checked against a sha256 written in the Dockerfile for both amd64 and arm64: [Typst](https://github.com/typst/typst/releases/tag/v0.15.1), [Pandoc](https://github.com/jgm/pandoc/releases/tag/3.13), [Quarto](https://github.com/quarto-dev/quarto-cli/releases/tag/v1.11.9); WeasyPrint 70.0 from [PyPI](https://pypi.org/project/weasyprint/70.0/) into its own venv; Chromium, Poppler and the Noto fonts from Debian bookworm; MJML and every Node dependency from `pnpm-lock.yaml`. CI builds it on every push and pull request, runs `scripts/engine-drill.sh` inside it, starts it read-only and renders every template's sample through the API (`node scripts/fabula.mjs smoke`). Nothing is pushed to a registry.

## Limitations

- Pandoc and Quarto templates take values in their PDFs only (through Typst); their HTML, Word and PowerPoint outputs show the template's own text.
- HTML and MJML templates substitute text, numbers and true/false; there are no loops. Lists belong in Typst templates.
- Quarto is not sandboxed: see [Security](#security).
- Each Chromium render starts its own browser, about a second or two each; Quarto's start-up is of the same order.
- The replay guard is per process (see [Configuration](#configuration)).
- The image is large (every engine and Chromium): a deployment that needs fewer engines can build from the Dockerfile without them and set `FABULA_ENGINES`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): `pnpm install`, `pnpm lint`, `pnpm type-check`, `pnpm test`. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Baja Labs. The engines keep their own licences: Typst (Apache-2.0), Pandoc (GPL-2.0-or-later), Quarto (MIT), WeasyPrint (BSD-3-Clause), MJML (MIT), Chromium (BSD-3-Clause and others); the Docker image bundles them unmodified.
