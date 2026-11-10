# Changelog

All notable changes to this project are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## Unreleased

## 1.0.0 - 2026-11-10

The first public release.

### Added

- `POST /render` and `POST /preview`: a template by name, or a source of the request's own, with values, an optional
  brand and per-engine options, to PDF, HTML, email HTML, `.docx`, `.pptx`, PNG or JPEG; page previews of a PDF;
  signed callbacks for long renders.
- Engines: Typst, Pandoc (Markdown, and a `.docx` read back), Quarto, WeasyPrint, MJML, and headless Chromium over the
  DevTools protocol.
- Seven example templates, one or more per engine.
- Field types `string`, `number`, `integer`, `money_cents`, `boolean`, `date`, `enum`, `array`, `object`, `sections`,
  `contact`, checked for every request before any engine runs; `POST /data/validate` checks the same types and
  `POST /data/parse` reads CSV, JSON, YAML and TOML.
- Callers by HMAC-signed request or bearer token; every setting an environment variable with a documented default.
- A Dockerfile with every engine (each release checked against its sha256), `compose.yaml` with a read-only,
  capability-free container, and a command-line client (`scripts/fabula.mjs`).

### Security

- A number, boolean, list or object sent for a text field is refused for every engine, not passed to it.
- HTML and MJML refuse a list or an object in a `{{ key }}`, and a template's `{{ key }}` must be a declared field.
- No value, and no brand string in `_brand.yml`, can become a Quarto shortcode.
- The pixel bound reads a JPEG as its decoder does (stray `FF 00` bytes no longer hide a frame), takes a WebP's
  bitstream size as well as its canvas, and applies to raster logos; an SVG logo with a DOCTYPE or an entity is
  refused.
- The asset cache links a file into the render before trusting it, so a concurrent eviction cannot take it away,
  and an error no longer carries a server path.
- The document templates break long words without inserting U+200B, so a copied address works.
- Engine processes run with no service secret in their environment and no reachable network; Pandoc runs with
  `--sandbox`; WeasyPrint reads only `data:` URLs and its render folder; MJML reads no include; Chromium runs no
  script and loads only the render's files; Quarto never runs code and refuses front matter and shortcodes that load
  code or files.
