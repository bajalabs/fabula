/* QuartoEngine: .qmd to PDF (through Quarto's typst format and its bundled Typst) or HTML, with `quarto render`.

   Code cells are never executed unless engineConfig.allowCodeExecution is true, and the image carries no R or
   Jupyter kernel. Each render gets its own work directory, a kill-after timeout and a stripped environment. */

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
import { toTypstLiteral, type FieldTypeHint } from '../../util/typst-literal.js'
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

const DEFAULT_TIMEOUT_MS = 30_000
const CODE_EXEC_TIMEOUT_MS = 60_000

function composeSource(
  userSource: string,
  fields: EngineRenderRequest['fields'],
  values: Record<string, unknown>,
  allowCodeExecution: boolean,
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

  // If the doc already has YAML frontmatter, leave it alone — we
  // inject defaults via a sidecar _quarto.yml. If the doc starts
  // without frontmatter, add a minimal one so Quarto knows the
  // format. Either way, prepend the execute-guard if code exec
  // is disabled (takes precedence over doc-level settings).
  const startsWithFrontmatter = userSource.trimStart().startsWith('---')

  const execGuard = allowCodeExecution
    ? ''
    : '---\nexecute:\n  enabled: false\n---\n'

  if (startsWithFrontmatter) {
    return execGuard + typstPreamble + userSource
  }
  return '---\ntitle: " "\n---\n' + execGuard + typstPreamble + userSource
}

function parseErrors(stderr: string): CompileError[] {
  const errors: CompileError[] = []
  for (const line of stderr.split('\n')) {
    const m = line.match(/^(?:ERROR|Error|WARNING|Warning):?\s*(.*)$/)
    if (m && m[1].trim()) {
      errors.push({
        severity: /warning/i.test(line) ? 'warning' : 'error',
        message: m[1].trim(),
      })
    }
  }
  if (errors.length === 0 && stderr.trim()) {
    errors.push({ severity: 'error', message: stderr.trim().slice(0, 1500) })
  }
  // Quarto's own ERROR line is often a bare "producing PDF."; the lines before it say what failed
  const tail = stderr.trim().split('\n').slice(-12).join('\n')
  for (const e of errors) if (e.severity === 'error' && e.message.length < 40 && tail) e.message = `${e.message}\n${tail}`.slice(0, 1500)
  return errors
}

interface QuartoOptions {
  allowCodeExecution?: boolean
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
    const allowCodeExec = opts.allowCodeExecution === true
    const timeoutMs =
      opts.timeoutMs ??
      (allowCodeExec ? CODE_EXEC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)

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
        `  enabled: ${allowCodeExec ? 'true' : 'false'}`,
        '  cache: false',
        '',
      ].join('\n')
      await writeFile(join(workDir, '_quarto.yml'), quartoYml, 'utf-8')

      const composed = composeSource(
        req.source,
        req.fields,
        req.values,
        allowCodeExec,
      )
      const entryName = 'main.qmd'
      const entryPath = join(workDir, entryName)
      await writeFile(entryPath, composed, 'utf-8')

      // A PDF comes from Quarto's typst format (its bundled Typst writes main.pdf). Quarto's pdf format is its
      // LaTeX path, and the image carries no LaTeX.
      const toFormat = req.output === 'pdf' ? 'typst' : 'html'
      const args = ['render', entryName, '--to', toFormat, '--no-cache']

      // Stripped env — pass through what Typst/Quarto actually need
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      }
      const pkgCache = process.env.TYPST_PACKAGE_CACHE_PATH
      if (pkgCache) baseEnv.TYPST_PACKAGE_CACHE_PATH = pkgCache
      // Typst's own variable for --font-path, for a typst Quarto spawns
      // without font flags of its own
      if (fontDir) baseEnv.TYPST_FONT_PATHS = fontDir
      // Explicitly disable telemetry that Quarto would otherwise phone home
      baseEnv.QUARTO_NO_ANALYTICS = '1'
      baseEnv.QUARTO_CHROME_ERROR_ON_MISSING = '1'

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
