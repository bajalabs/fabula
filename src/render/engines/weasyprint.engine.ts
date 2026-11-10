/* WeasyPrintEngine: HTML and CSS (paged media) to PDF.

     1. {{ key }} substitution in the source, HTML-escaped.
     2. The brand stylesheet as a <style> block in <head>.
     3. `weasyprint main.html main.pdf` in a fresh work directory, beside the brand's files.

   WeasyPrint runs no JavaScript. */

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
import { readPdfOptions, weasyprintPdfArgs } from '../../contracts/pdf-options.js'
import { BrandIdentityService } from '../brand/brand-identity.service.js'
import {
  BrandAssetsService,
  PRINT_HTML_ASSET_FORMATS,
} from '../brand/brand-assets.service.js'
import { substitute } from '../../util/mustache.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../../contracts/engine.js'

const DEFAULT_TIMEOUT_MS = 20_000

function composeSource(
  userSource: string,
  brandCss: string,
  values: Record<string, unknown>,
  fields: EngineRenderRequest['fields'],
): string {
  // Default-resolve values from field defaults so {{ key }} substitutions
  // with no user value still render meaningfully.
  const resolved: Record<string, unknown> = {}
  for (const f of fields) {
    resolved[f.key] =
      Object.prototype.hasOwnProperty.call(values, f.key)
        ? values[f.key]
        : f.defaultValue
  }
  for (const [k, v] of Object.entries(values)) resolved[k] = v

  const filled = substitute(userSource, resolved, 'html')

  // Inject brand stylesheet via a prepended <style> block. If the
  // template author already has <html><head>, we slip in there;
  // otherwise wrap in a full document.
  const brandStyle = `<style data-brand>\n${brandCss}\n</style>`
  if (/<head\b[^>]*>/i.test(filled)) {
    return filled.replace(/<head\b[^>]*>/i, (m) => `${m}\n${brandStyle}`)
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${brandStyle}
</head>
<body>
${filled}
</body>
</html>`
}

function parseErrors(stderr: string): CompileError[] {
  const errors: CompileError[] = []
  // WeasyPrint lines look like:
  //   WARNING: Ignored `color: #zzz` at 1:2, invalid color.
  //   ERROR: Couldn't load ...
  for (const line of stderr.split('\n')) {
    const m = line.match(/^(WARNING|ERROR|CRITICAL):\s*(.*)$/)
    if (m) {
      errors.push({
        severity: m[1].toUpperCase() === 'WARNING' ? 'warning' : 'error',
        message: m[2].trim(),
      })
    }
  }
  if (errors.length === 0 && stderr.trim()) {
    errors.push({
      severity: 'error',
      message: stderr.trim().slice(0, 1200),
    })
  }
  return errors
}

@Injectable()
export class WeasyPrintEngine implements RenderEngine {
  readonly format: RenderFormat = 'html'
  readonly outputs: readonly OutputType[] = ['pdf']

  constructor(
    private readonly brandIdentity: BrandIdentityService,
    private readonly brandAssets: BrandAssetsService,
  ) {}

  async render(req: EngineRenderRequest): Promise<EngineRenderResult> {
    if (req.output !== 'pdf') {
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: `WeasyPrintEngine output '${req.output}' not supported (pdf only).`,
          },
        ],
      }
    }

    // Tagged by default; PDF/UA-1 or one PDF/A level when the template asks
    const pdfOpts = readPdfOptions(req.engineConfig)
    if (!pdfOpts.ok) return pdfOpts
    const pdfArgs = weasyprintPdfArgs(pdfOpts.pdf)
    if (!pdfArgs.ok) return pdfArgs

    const workDir = join(tmpdir(), `fabula-weasy-${randomUUID()}`)
    const htmlPath = join(workDir, 'main.html')
    const pdfPath = join(workDir, 'main.pdf')

    try {
      await mkdir(workDir, { recursive: true })
      // Brand record files sit beside main.html, so the stylesheet's
      // relative url()s (@font-face, logos) resolve against it
      const placed = await this.brandAssets.place(req.brand, workDir, PRINT_HTML_ASSET_FORMATS)
      if (!placed.ok) return placed
      const brandCss = this.brandIdentity.buildHtml(req.brand, placed.assets)
      const composed = composeSource(req.source, brandCss, req.values, req.fields)
      await writeFile(htmlPath, composed, 'utf-8')

      const args = [
        htmlPath,
        pdfPath,
        '--presentational-hints',
        '--media-type',
        'print',
        ...pdfArgs.args,
      ]

      return await new Promise<EngineRenderResult>((resolve) => {
        const proc = spawn('weasyprint', args, {
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: process.env.HOME ?? '/tmp',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const stderrChunks: Buffer[] = []
        let timedOut = false
        const killTimer = setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
        }, DEFAULT_TIMEOUT_MS)

        proc.stderr.on('data', (c) => stderrChunks.push(c))
        proc.stdout.on('data', () => {
          /* drain */
        })

        proc.on('error', (err) => {
          clearTimeout(killTimer)
          resolve({
            ok: false,
            errors: [
              {
                severity: 'error',
                message: `weasyprint spawn failed: ${err.message}`,
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
                  message: `weasyprint timed out after ${DEFAULT_TIMEOUT_MS}ms`,
                },
              ],
            })
            return
          }
          if (code !== 0) {
            resolve({
              ok: false,
              errors: parseErrors(
                Buffer.concat(stderrChunks).toString('utf-8'),
              ),
            })
            return
          }
          try {
            const bytes = new Uint8Array(await readFile(pdfPath))
            // Surface non-fatal warnings in success response
            const stderr = Buffer.concat(stderrChunks).toString('utf-8')
            const warnings = parseErrors(stderr).filter(
              (e) => e.severity === 'warning',
            )
            resolve({
              ok: true,
              bytes,
              mime: 'application/pdf',
              ...(warnings.length ? { warnings } : {}),
            })
          } catch (err) {
            resolve({
              ok: false,
              errors: [
                {
                  severity: 'error',
                  message: `weasyprint produced no output file: ${
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
