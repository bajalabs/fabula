/* PandocEngine: Markdown to PDF (through Typst), HTML, Word or PowerPoint, and a finished .docx read back to PDF or
   HTML.

   PDFs go through Typst (--pdf-engine=typst), so no TeX installation is needed. The field values reach the document as
   `#let key = value` lines in a raw Typst block, as in TypstEngine; an HTML output drops that block.

   Word and PowerPoint take a reference document per brand: Pandoc's own default reference.docx / reference.pptx with
   the brand's theme (accent colours, heading and body typefaces) written by scripts/office-theme.py. These are the
   editable files; a .docx edited elsewhere comes back as format 'docx' (base64 source) and leaves as the final PDF. */

import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompileError,
  OutputType,
  RenderFormat,
} from '../../contracts/index.js'
import { pandocPdfArgs, readPdfOptions } from '../../contracts/pdf-options.js'
import { toTypstLiteral, type FieldTypeHint } from '../../util/typst-literal.js'
import {
  BrandIdentityService,
  brandFamilies,
  brandOfficeTheme,
} from '../brand/brand-identity.service.js'
import {
  BrandAssetsService,
  NO_BRAND_ASSETS,
  TYPST_ASSET_FORMATS,
  type BrandAssetsResult,
} from '../brand/brand-assets.service.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../../contracts/engine.js'

/** Pandoc writes -V values into its Typst template verbatim, inside
 *  quotes: a font name keeps everything but quotes, backslashes and
 *  control characters. */
function plainFontName(s: string): string {
  return s.replace(/["\\\u0000-\u001F\u007F]/g, '').trim()
}

function composeSource(
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
  // Typst preamble goes in a raw Typst block so Pandoc passes it
  // through to the Typst writer. For HTML output this block is
  // silently dropped — document body still renders normally.
  const preamble =
    '```{=typst}\n' +
    letLines.join('\n') +
    '\n```\n\n'
  return preamble + userSource
}

const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const

/** The script that writes a brand's reference .docx / .pptx, from the app's root (/app in the image). */
const OFFICE_THEME_SCRIPT = resolve(process.cwd(), 'scripts', 'office-theme.py')

/** A .docx read back: what it may become, and its size cap. */
const DOCX_INPUT_OUTPUTS: readonly OutputType[] = ['pdf', 'html']
const DOCX_MAX_BYTES = 20 * 1024 * 1024
const PANDOC_TIMEOUT_MS = 120_000

const fail = (message: string): { ok: false; errors: CompileError[] } => ({ ok: false, errors: [{ severity: 'error', message }] })

/** One child process with its output collected, and a deadline. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: Buffer; stderr: string; error?: string }> {
  return new Promise((done) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => proc.kill('SIGKILL'), PANDOC_TIMEOUT_MS)
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    proc.on('error', (e: Error) => {
      clearTimeout(timer)
      done({ code: -1, stdout: Buffer.alloc(0), stderr: '', error: e.message })
    })
    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      done({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf-8') })
    })
  })
}

function parseErrors(stderr: string): CompileError[] {
  const errors: CompileError[] = []
  // Pandoc: `<filename>: <pos>: <msg>` OR `Error producing PDF: <typst errs>`
  for (const line of stderr.split('\n')) {
    const m = line.match(/^(?:Error|Warning):?\s*(.*)$/i)
    if (m && m[1].trim()) {
      errors.push({
        severity: line.toLowerCase().startsWith('warning')
          ? 'warning'
          : 'error',
        message: m[1].trim(),
      })
    }
  }
  if (errors.length === 0 && stderr.trim()) {
    errors.push({ severity: 'error', message: stderr.trim().slice(0, 1000) })
  }
  return errors
}

@Injectable()
export class PandocEngine implements RenderEngine {
  readonly format: RenderFormat = 'markdown'
  readonly outputs: readonly OutputType[] = ['pdf', 'html', 'docx', 'pptx']

  constructor(
    private readonly brandIdentity: BrandIdentityService,
    private readonly brandAssets: BrandAssetsService,
  ) {}

  render(req: EngineRenderRequest): Promise<EngineRenderResult> {
    return this.renderFrom(req, 'markdown')
  }

  /** Format 'docx': a finished .docx (base64 in `source`) read back to the final PDF or HTML. */
  asDocxReader(): RenderEngine {
    return { format: 'docx', outputs: DOCX_INPUT_OUTPUTS, render: (req) => this.renderFrom(req, 'docx') }
  }

  private async renderFrom(req: EngineRenderRequest, input: 'markdown' | 'docx'): Promise<EngineRenderResult> {
    const allowed = input === 'docx' ? DOCX_INPUT_OUTPUTS : this.outputs
    if (!allowed.includes(req.output)) {
      return fail(`PandocEngine ${input} → '${req.output}' not supported (${allowed.join(', ')})`)
    }

    // Tagged by default; PDF/UA-1 and PDF/A when the template asks
    const pdfOpts = readPdfOptions(req.engineConfig)
    if (!pdfOpts.ok) return pdfOpts

    const workDir = join(tmpdir(), `fabula-pandoc-${randomUUID()}`)
    const sharedDir = join(workDir, '_shared')
    const isPdf = req.output === 'pdf'
    const office = req.output === 'docx' || req.output === 'pptx' ? req.output : null

    try {
      await mkdir(sharedDir, { recursive: true })
      // Brand record files reach the PDF only (Typst draws it); the
      // HTML output carries no brand stylesheet, so it fetches nothing.
      const placed: BrandAssetsResult = isPdf
        ? await this.brandAssets.place(req.brand, workDir, TYPST_ASSET_FORMATS)
        : { ok: true, assets: NO_BRAND_ASSETS }
      if (!placed.ok) return placed
      // Same brand helper file Pandoc can `{=typst}` import
      await writeFile(
        join(sharedDir, 'brand.typ'),
        this.brandIdentity.buildTypst(req.brand, placed.assets),
        'utf-8',
      )

      let entryPath: string
      if (input === 'docx') {
        const bytes = Buffer.from(req.source, 'base64')
        if (bytes.length > DOCX_MAX_BYTES) return fail(`the .docx is larger than ${DOCX_MAX_BYTES / (1024 * 1024)} MB`)
        if (bytes.subarray(0, 4).toString('latin1') !== 'PK\u0003\u0004') return fail('source is not a base64 .docx')
        entryPath = join(workDir, 'main.docx')
        await writeFile(entryPath, bytes)
      } else {
        entryPath = join(workDir, 'main.md')
        await writeFile(entryPath, composeSource(req.source, req.fields, req.values), 'utf-8')
      }

      const args: string[] = [
        entryPath,
        input === 'docx' ? '--from=docx' : '--from=markdown+raw_attribute',
        `--to=${req.output}`,
      ]
      if (isPdf) {
        // Pandoc's default Typst template sets a font list whose first
        // entry is "Linux Libertine" — absent on most systems. Pass the
        // brand font through as `mainfont` so Typst has a real fallback.
        // The record's body / heading / mono fonts win over the legacy
        // fields; their files reach Typst through --font-path.
        const families = brandFamilies(req.brand)
        args.push('--pdf-engine=typst')
        args.push('--variable', `mainfont=${plainFontName(families.body)}`)
        if (families.heading) {
          args.push('--variable', `sansfont=${plainFontName(families.heading)}`)
          // Pandoc's Typst template has no heading font (sansfont is not used there): a show rule through
          // header-includes gives headings the brand's heading face
          args.push('--variable', `header-includes=#show heading: set text(font: ${toTypstLiteral(families.heading)})`)
        }
        if (families.mono) {
          args.push('--variable', `codefont=${plainFontName(families.mono)}`)
        }
        if (placed.assets.fontDir) {
          args.push(`--pdf-engine-opt=--font-path=${placed.assets.fontDir}`)
        }
        args.push(...pandocPdfArgs(pdfOpts.pdf))
      } else if (office) {
        const ref = await this.brandReference(office, req, workDir)
        if (!ref.ok) return ref
        args.push(`--reference-doc=${ref.path}`)
      } else {
        args.push('--standalone')
      }
      // Word and PowerPoint are written to a file; PDF and HTML to stdout, as before
      const outPath = office ? join(workDir, `out.${office}`) : null
      args.push(outPath ? `--output=${outPath}` : '--output=-')

      const pkgCache = process.env.TYPST_PACKAGE_CACHE_PATH
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(pkgCache ? { TYPST_PACKAGE_CACHE_PATH: pkgCache } : {}),
      }

      const r = await run('pandoc', args, { cwd: workDir, env })
      if (r.error) return fail(`pandoc spawn failed: ${r.error}`)
      if (r.code !== 0) return { ok: false, errors: parseErrors(r.stderr) }
      return {
        ok: true,
        bytes: outPath ? new Uint8Array(await readFile(outPath)) : new Uint8Array(r.stdout),
        mime: isPdf ? 'application/pdf' : office ? OFFICE_MIME[office] : 'text/html; charset=utf-8',
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** The brand's reference .docx / .pptx: Pandoc's default one with the brand's theme. */
  private async brandReference(
    kind: 'docx' | 'pptx',
    req: EngineRenderRequest,
    workDir: string,
  ): Promise<{ ok: true; path: string } | { ok: false; errors: CompileError[] }> {
    const base = join(workDir, `default.${kind}`)
    const d = await run('pandoc', ['-o', base, '--print-default-data-file', `reference.${kind}`], { cwd: workDir })
    if (d.error || d.code !== 0) return fail(`pandoc could not write its default reference.${kind}: ${d.error ?? d.stderr.trim().slice(0, 300)}`)
    const spec = join(workDir, 'theme.json')
    await writeFile(spec, JSON.stringify(brandOfficeTheme(req.brand)), 'utf-8')
    const path = join(workDir, `brand-reference.${kind}`)
    const s = await run('python3', [OFFICE_THEME_SCRIPT, base, path, spec], { cwd: workDir })
    if (s.error || s.code !== 0) return fail(`the brand's reference.${kind} could not be written: ${s.error ?? s.stderr.trim().slice(0, 300)}`)
    return { ok: true, path }
  }
}
