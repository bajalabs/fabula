/* PagePreviewService: a PNG of every page of a rendered PDF.

   One path for every engine: Poppler's `pdfinfo` reads the page count and `pdftoppm` rasterises the PDF the engine
   wrote, at the asked resolution. At most `maxPages` pages come back; `pageCount` says how many the PDF has. Per
   render: its own temp dir, a 60 s limit, a stripped environment, nothing left behind. */

import { Injectable } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompileError, PagePreview, PreviewOptions } from '../contracts/index.js'

const TIMEOUT_MS = 60_000

export type PagePreviewResult =
  | { ok: true; pages: PagePreview[]; pageCount: number }
  | { ok: false; errors: CompileError[] }

/** Width and height from a PNG's IHDR chunk (bytes 16–23, big-endian). */
export function pngSize(bytes: Uint8Array): { widthPx: number; heightPx: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { widthPx: v.getUint32(16), heightPx: v.getUint32(20) }
}

/** pdftoppm names pages p-1.png … or p-01.png … depending on the count: the number after the last dash. */
export function pageNumberOf(file: string): number | null {
  const m = file.match(/-(\d+)\.png$/)
  return m ? parseInt(m[1], 10) : null
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, TIMEOUT_MS)
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8'), timedOut })
    })
  })
}

const failure = (message: string): PagePreviewResult => ({ ok: false, errors: [{ severity: 'error', message, file: 'previews' }] })

@Injectable()
export class PagePreviewService {
  async rasterise(pdf: Uint8Array, opts: PreviewOptions): Promise<PagePreviewResult> {
    const dir = join(tmpdir(), `fabula-pages-${randomUUID()}`)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, 'in.pdf'), pdf)

      const info = await run('pdfinfo', ['in.pdf'], dir)
      if (info.timedOut) return failure(`pdfinfo timed out after ${TIMEOUT_MS / 1000} s`)
      if (info.code !== 0) return failure(`pdfinfo could not read the PDF: ${info.stderr.trim().slice(0, 300)}`)
      const pageCount = parseInt(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? '0', 10)
      if (!pageCount) return failure('the PDF has no pages')

      const last = Math.min(pageCount, opts.maxPages)
      const ras = await run('pdftoppm', ['-png', '-r', String(opts.ppi), '-f', '1', '-l', String(last), 'in.pdf', 'p'], dir)
      if (ras.timedOut) return failure(`pdftoppm timed out after ${TIMEOUT_MS / 1000} s`)
      if (ras.code !== 0) return failure(`pdftoppm failed: ${ras.stderr.trim().slice(0, 300)}`)

      const files = (await readdir(dir))
        .map((f) => ({ f, n: pageNumberOf(f) }))
        .filter((x): x is { f: string; n: number } => x.n !== null && x.f.startsWith('p-'))
        .sort((a, b) => a.n - b.n)
      if (files.length !== last) return failure(`pdftoppm wrote ${files.length} pages, ${last} expected`)

      const pages: PagePreview[] = []
      for (const { f, n } of files) {
        const bytes = new Uint8Array(await readFile(join(dir, f)))
        const size = pngSize(bytes)
        if (!size) return failure(`page ${n} is not a PNG`)
        pages.push({ page: n, mime: 'image/png', bytes: Buffer.from(bytes).toString('base64'), ...size })
      }
      return { ok: true, pages, pageCount }
    } catch (err) {
      return failure(`page previews failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
