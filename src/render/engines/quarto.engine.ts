/* QuartoEngine: .qmd to PDF (through Quarto's typst format and its bundled Typst) or HTML, with `quarto render`.

   Code cells are never executed (`execute: enabled: false`, and the image carries no R or Jupyter kernel). Each render
   gets its own work directory, engineEnv() (no service secret, no reachable network) and FABULA_RENDER_TIMEOUT_SECONDS
   (engineConfig.timeoutMs may only shorten it).

   Quarto is a document system that trusts its documents: an image path or an include can read any file the service
   can. Before the render, a source is refused when its front matter names something that loads code or files
   (filters, shortcodes, engines, includes, templates, metadata files…) or when it uses a shortcode other than
   pagebreak, meta, var, kbd, lipsum and placeholder. That narrows what a source can do; it is not a sandbox, and
   SECURITY.md says what to do when the callers who send sources are not trusted. */

import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompileError,
  OutputType,
  RenderFormat,
} from '../../contracts/index.js'
import { quartoPdfYaml, readPdfOptions } from '../../contracts/pdf-options.js'
import YAML from 'yaml'
import { toTypstLiteral, type FieldTypeHint } from '../../util/typst-literal.js'
import { settings } from '../../config/settings.js'
import { engineEnv } from './subprocess.js'
import { BrandIdentityService } from '../brand/brand-identity.service.js'
import {
  BrandAssetsService,
  TYPST_ASSET_FORMATS,
  WEB_HTML_ASSET_FORMATS,
} from '../brand/brand-assets.service.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../../contracts/engine.js'

/** Front-matter keys that load code or files, refused at any depth. */
const DENIED_KEYS = new Set([
  'filters', 'shortcodes', 'engine', 'engines', 'jupyter', 'knitr', 'execute', 'execute-dir', 'extensions', 'project',
  'include-in-header', 'include-before-body', 'include-after-body', 'include-before', 'include-after',
  'metadata-files', 'template', 'template-partials', 'resources', 'resource-path', 'output-dir', 'output-file',
  'pdf-engine', 'pdf-engine-opt', 'pdf-engine-opts', 'bibliography', 'csl', 'citation-abbreviations',
])
/** Shortcodes that read nothing outside the document. */
const ALLOWED_SHORTCODES = new Set(['pagebreak', 'meta', 'var', 'kbd', 'lipsum', 'placeholder'])

/** Why Quarto must not render `source`; empty when nothing is refused. */
export function quartoSourceProblems(source: string): string[] {
  const problems: string[] = []
  for (const m of source.matchAll(/(?<!\{)\{\{<\s*([A-Za-z0-9_-]*)/g)) {
    const name = m[1].toLowerCase()
    if (!ALLOWED_SHORTCODES.has(name)) problems.push(`the {{< ${name || '?'} >}} shortcode is refused (allowed: ${[...ALLOWED_SHORTCODES].join(', ')})`)
  }
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const here = path ? `${path}.${k}` : k
        if (DENIED_KEYS.has(k.toLowerCase())) problems.push(`front matter \`${here}\` loads code or files and is refused`)
        walk(x, here)
      }
    }
  }
  // Pandoc reads a YAML block anywhere in the document: every --- … --- (or …) block that parses is checked
  for (const m of source.matchAll(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*$/gm)) {
    try {
      walk(YAML.parse(m[1]), '')
    } catch {
      // not YAML: Pandoc reads it as a rule and text, not as metadata
    }
  }
  return [...new Set(problems)]
}

export function composeSource(
  userSource: string,
  fields: EngineRenderRequest['fields'],
  values: Record<string, unknown>,
): string {
  const letLines = fields.map((f) => {
    const raw = Object.prototype.hasOwnProperty.call(values, f.key)
      ? values[f.key]
      : f.defaultValue
    return `#let ${f.key} = ${toTypstLiteral(raw, f.fieldTypeKey as FieldTypeHint)}`
  })

  // Typst-side data preamble as a raw block (skipped in HTML).
  const typstPreamble =
    '```{=typst}\n' +
    letLines.join('\n') +
    '\n```\n\n'

  // A document with its own front matter keeps it (its `execute` was refused above); one without gets a minimal one
  const startsWithFrontmatter = userSource.trimStart().startsWith('---')
  const execGuard = '---\nexecute:\n  enabled: false\n---\n'

  if (startsWithFrontmatter) {
    return execGuard + typstPreamble + userSource
  }
  return '---\ntitle: " "\n---\n' + execGuard + typstPreamble + userSource
}

// eslint-disable-next-line no-control-regex -- the escape character is what this removes
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/**
 * Quarto's stderr as compile errors. Quarto colours its lines (`\x1b[91mERROR: …`) and prints its settings first, so
 * the colours go before the match, Typst's own `error: ` inside Quarto's `ERROR: ` goes, a repeated message is kept
 * once, and with no ERROR or WARNING line the last lines (where the failure is) stand for the message.
 */
export function parseErrors(stderr: string): CompileError[] {
  const text = stderr.replace(ANSI, '')
  const errors: CompileError[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^(ERROR|WARN(?:ING)?):\s*(.*)$/i)
    if (!m) continue
    const severity = /^warn/i.test(m[1]) ? 'warning' : 'error'
    const message = m[2].replace(/^(?:error|warning):\s*/i, '').trim()
    if (!message || seen.has(`${severity}:${message}`)) continue
    seen.add(`${severity}:${message}`)
    errors.push({ severity, message })
  }
  if (!errors.some((e) => e.severity === 'error') && text.trim()) {
    errors.push({ severity: 'error', message: text.trim().split('\n').slice(-12).join('\n').slice(-1500) })
  }
  return errors
}

interface QuartoOptions {
  timeoutMs?: number
}

@Injectable()
export class QuartoEngine implements RenderEngine {
  readonly format: RenderFormat = 'quarto'
  readonly outputs: readonly OutputType[] = ['pdf', 'html']

  constructor(
    private readonly brandIdentity: BrandIdentityService,
    private readonly brandAssets: BrandAssetsService,
  ) {}

  async render(req: EngineRenderRequest): Promise<EngineRenderResult> {
    if (!this.outputs.includes(req.output)) {
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: `QuartoEngine output '${req.output}' not supported (pdf, html)`,
          },
        ],
      }
    }

    const opts = (req.engineConfig ?? {}) as QuartoOptions
    const limit = settings().renderTimeoutMs
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, limit) : limit

    const problems = quartoSourceProblems(req.source)
    if (problems.length) return { ok: false, errors: problems.map((message) => ({ severity: 'error', message, file: 'main.qmd' })) }

    // Tagged by default; PDF/UA-1 and PDF/A when the template asks
    const pdfOpts = readPdfOptions(req.engineConfig)
    if (!pdfOpts.ok) return pdfOpts

    const workDir = join(tmpdir(), `fabula-quarto-${randomUUID()}`)
    const sharedDir = join(workDir, '_shared')

    try {
      await mkdir(sharedDir, { recursive: true })
      // Brand record files: TrueType / OpenType for the Typst PDF,
      // WOFF2 first for the HTML page
      const placed = await this.brandAssets.place(
        req.brand,
        workDir,
        req.output === 'pdf' ? TYPST_ASSET_FORMATS : WEB_HTML_ASSET_FORMATS,
      )
      if (!placed.ok) return placed
      const fontDir = placed.assets.fontDir
      await writeFile(
        join(sharedDir, 'brand.typ'),
        this.brandIdentity.buildTypst(req.brand, placed.assets),
        'utf-8',
      )

      // _brand.yml (Quarto's brand.yml) only when the request carries
      // the brand record; Quarto picks it up from the project dir.
      const brandYml = this.brandIdentity.buildQuartoBrand(req.brand, placed.assets)
      if (brandYml) await writeFile(join(workDir, '_brand.yml'), brandYml, 'utf-8')

      // _quarto.yml: the typst format (a PDF's way) + code-exec
      // gate; with brand fonts, their folder reaches Quarto's Typst.
      const quartoYml = [
        'project:',
        '  type: default',
        'format:',
        '  typst:',
        '    keep-typ: false',
        ...(fontDir ? ['    font-paths:', `      - ${JSON.stringify(fontDir)}`] : []),
        ...(req.output === 'pdf' ? quartoPdfYaml(pdfOpts.pdf) : []),
        '  html:',
        '    embed-resources: true',
        'execute:',
        '  enabled: false',
        '  cache: false',
        '',
      ].join('\n')
      await writeFile(join(workDir, '_quarto.yml'), quartoYml, 'utf-8')

      const composed = composeSource(req.source, req.fields, req.values)
      const entryName = 'main.qmd'
      const entryPath = join(workDir, entryName)
      await writeFile(entryPath, composed, 'utf-8')

      // A PDF comes from Quarto's typst format (its bundled Typst writes main.pdf). Quarto's pdf format is its
      // LaTeX path, and the image carries no LaTeX.
      const toFormat = req.output === 'pdf' ? 'typst' : 'html'
      const args = ['render', entryName, '--to', toFormat, '--no-cache']

      // Typst's own variable for --font-path, for the typst Quarto spawns without font flags of its own; no analytics
      const baseEnv = engineEnv({
        TYPST_FONT_PATHS: fontDir ?? undefined,
        QUARTO_NO_ANALYTICS: '1',
        QUARTO_CHROME_ERROR_ON_MISSING: '1',
      })

      return await new Promise<EngineRenderResult>((resolve) => {
        const proc = spawn('quarto', args, {
          env: baseEnv,
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const stderrChunks: Buffer[] = []
        let timedOut = false
        const killTimer = setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
        }, timeoutMs)

        proc.stderr.on('data', (c) => stderrChunks.push(c))
        proc.stdout.on('data', () => {
          /* pipe drain */
        })

        proc.on('error', (err) => {
          clearTimeout(killTimer)
          resolve({
            ok: false,
            errors: [
              {
                severity: 'error',
                message: `quarto spawn failed: ${err.message}`,
              },
            ],
          })
        })

        proc.on('close', async (code) => {
          clearTimeout(killTimer)
          if (timedOut) {
            resolve({
              ok: false,
              errors: [
                {
                  severity: 'error',
                  message: `quarto render timed out after ${timeoutMs}ms`,
                },
              ],
            })
            return
          }
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString('utf-8')
            resolve({ ok: false, errors: parseErrors(stderr) })
            return
          }

          // Quarto writes output to main.<ext>; read it back.
          const ext = toFormat === 'typst' ? 'pdf' : 'html'
          const outPath = join(workDir, `main.${ext}`)
          try {
            const bytes = new Uint8Array(await readFile(outPath))
            resolve({
              ok: true,
              bytes,
              mime:
                ext === 'pdf'
                  ? 'application/pdf'
                  : 'text/html; charset=utf-8',
            })
          } catch (err) {
            resolve({
              ok: false,
              errors: [
                {
                  severity: 'error',
                  message: `quarto produced no output file: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                },
              ],
            })
          }
        })
      })
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
