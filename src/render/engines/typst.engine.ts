/* TypstEngine: `typst compile` in a fresh work directory: the field values as `#let` lines before the template's
   source, the brand as _shared/brand.typ, the brand's files and the document's pictures under _shared/. Typst reads
   nothing outside the work directory (--root). */

import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CompileError,
  OutputType,
  RenderFormat,
} from '../../contracts/index.js'
import { readPdfOptions, typstPdfArgs } from '../../contracts/pdf-options.js'
import { toTypstLiteral, type FieldTypeHint } from '../../util/typst-literal.js'
import { documentImages, parseDocumentValues } from '../document-fields.js'
import { BrandIdentityService } from '../brand/brand-identity.service.js'
import {
  BrandAssetsService,
  TYPST_ASSET_FORMATS,
} from '../brand/brand-assets.service.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../../contracts/engine.js'

/** A compile that runs longer is killed: under the 60 s a caller gives a whole render, so it hears why. */
export const TYPST_COMPILE_TIMEOUT_MS = 45_000

export function composeSource(
  userSource: string,
  fields: EngineRenderRequest['fields'],
  values: Record<string, unknown>,
): { source: string; lineOffset: number } {
  const letLines = fields.map((f) => {
    const raw = Object.prototype.hasOwnProperty.call(values, f.key)
      ? values[f.key]
      : f.defaultValue
    return `#let ${f.key} = ${toTypstLiteral(raw, f.fieldTypeKey as FieldTypeHint)}`
  })
  const prefix = letLines.join('\n') + '\n\n'
  // The lines before the caller's source, so a compile error can name the caller's own line
  return { source: prefix + userSource, lineOffset: prefix.split('\n').length - 1 }
}

/** A diagnostic's file, relative to the render's work dir: `main.typ`, `_shared/brand.typ`, or a package's own
    path. Never the server's temp path. */
function relativeFile(file: string | undefined, workDir: string): string | undefined {
  if (!file) return undefined
  if (file.startsWith('@')) return file
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file)
  const rel = relative(workDir, abs)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  return abs.split(sep).pop()
}

/** Parse typst stderr into structured errors; lines in the entry file are the caller's own lines. */
export function parseErrors(stderr: string, workDir: string, lineOffset: number): CompileError[] {
  const errors: CompileError[] = []
  const lines = stderr.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(error|warning): (.*)$/)
    if (m) {
      const loc = lines[i + 1]?.match(/[\s┌├│└─╷╵]*(\S+?):(\d+):(\d+)/)
      let file = relativeFile(loc?.[1], workDir)
      let line = loc ? parseInt(loc[2], 10) : undefined
      if (file === 'main.typ' && line !== undefined) {
        // The injected field lets sit before the caller's source; an error there is in the fields
        if (line > lineOffset) line -= lineOffset
        else file = 'fields'
      }
      errors.push({
        severity: m[1] as 'error' | 'warning',
        message: m[2],
        file,
        line,
        column: loc ? parseInt(loc[3], 10) : undefined,
      })
    }
  }
  if (errors.length === 0 && stderr.trim()) {
    errors.push({
      severity: 'error',
      message: stderr.trim().slice(0, 1000),
    })
  }
  return errors
}

@Injectable()
export class TypstEngine implements RenderEngine {
  readonly format: RenderFormat = 'typst'
  readonly outputs: readonly OutputType[] = ['pdf']
  /** A spec shortens it. */
  compileTimeoutMs = TYPST_COMPILE_TIMEOUT_MS

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
            message: `TypstEngine output '${req.output}' not supported (pdf only)`,
          },
        ],
      }
    }

    // Tagged by default; PDF/UA-1 and PDF/A when the template asks
    const pdfOpts = readPdfOptions(req.engineConfig)
    if (!pdfOpts.ok) return pdfOpts

    // Typed fields: a wrong shape answers here, before anything is fetched
    const document = parseDocumentValues(req.fields, req.values)
    if (!document.ok) return document

    const workDir = join(tmpdir(), `fabula-typst-${randomUUID()}`)
    const sharedDir = join(workDir, '_shared')

    try {
      await mkdir(sharedDir, { recursive: true })
      // Brand record files → _shared/fonts + _shared/logos
      const placed = await this.brandAssets.place(req.brand, workDir, TYPST_ASSET_FORMATS)
      if (!placed.ok) return placed
      await writeFile(
        join(sharedDir, 'brand.typ'),
        this.brandIdentity.buildTypst(req.brand, placed.assets),
        'utf-8',
      )

      // A card's picture becomes a file in the work directory; a card without one draws nothing
      const pictures = documentImages(req.fields, document.values)
      const images = await this.brandAssets.placeImages(pictures, workDir)
      if (!images.ok) return images
      pictures.forEach((p, i) => p.place(images.paths[i]))

      const { source: composed, lineOffset } = composeSource(req.source, req.fields, document.values)
      const entryPath = join(workDir, 'main.typ')
      await writeFile(entryPath, composed, 'utf-8')

      const pkgCache = process.env.TYPST_PACKAGE_CACHE_PATH
      const args = ['compile', entryPath, '-', '--root', workDir]
      if (pkgCache) args.push('--package-path', pkgCache)
      if (placed.assets.fontDir) args.push('--font-path', placed.assets.fontDir)
      args.push(...typstPdfArgs(pdfOpts.pdf))

      return await new Promise<EngineRenderResult>((resolve) => {
        const proc = spawn('typst', args)
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve({
            ok: false,
            errors: [{ severity: 'error', message: `typst compile stopped after ${this.compileTimeoutMs / 1000} s`, file: 'main.typ' }],
          })
        }, this.compileTimeoutMs)
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        proc.stdout.on('data', (c) => stdoutChunks.push(c))
        proc.stderr.on('data', (c) => stderrChunks.push(c))
        proc.on('error', (err) => {
          clearTimeout(timer)
          resolve({
            ok: false,
            errors: [
              {
                severity: 'error',
                message: `typst spawn failed: ${err.message}`,
              },
            ],
          })
        })
        proc.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            resolve({
              ok: true,
              bytes: new Uint8Array(Buffer.concat(stdoutChunks)),
              mime: 'application/pdf',
            })
          } else {
            const stderr = Buffer.concat(stderrChunks).toString('utf-8')
            resolve({ ok: false, errors: parseErrors(stderr, workDir, lineOffset) })
          }
        })
      })
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
