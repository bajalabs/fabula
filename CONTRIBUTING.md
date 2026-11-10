# Contributing

Thank you for helping. Issues and pull requests are welcome; for a security problem, see [SECURITY.md](SECURITY.md)
instead.

## Build and test

Node 24 and pnpm 10 (`corepack enable` gives you the pnpm in `package.json`). pnpm only.

```sh
pnpm install
pnpm lint          # ESLint
pnpm type-check    # tsc, sources and specs
pnpm test          # Vitest, two workers
pnpm build         # dist/
pnpm dev           # rebuild and restart on change; reads .env
```

Most specs need no engine. Those that compile the document templates need Typst on the `PATH` (and Poppler's
`pdftotext` for one of them), and the Chromium ones need a Chrome or Chromium binary (`FABULA_CHROMIUM_PATH`, or
`chromium`/`google-chrome` on the `PATH`, or Google Chrome on a Mac); without them those specs skip. CI installs Typst
and Poppler, and its image job renders every template through every engine inside the Docker image:

```sh
docker build -t fabula:local .
docker run --rm fabula:local sh scripts/engine-drill.sh
```

## A change

- One change per pull request, with the reason in its description.
- A fix comes with the spec that failed before it. A new field type, engine option or setting comes with its spec and
  its line in the README (API or configuration table) and in `.env.example`.
- A new template is a new folder `templates/<kind>/<name>/v<version>/` with a `sample` that renders; an existing
  version is never edited in a way that changes its output, a new version is added instead.
- An engine's version moves in the Dockerfile together with its sha256 for both architectures, from the release's
  own digests.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

By contributing you agree that your contribution is licensed under the MIT licence of this repository.
