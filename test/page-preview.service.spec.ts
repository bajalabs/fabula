/* PagePreviewService: a PNG of every page, through Poppler. node:child_process.spawn is replaced by a fake pdfinfo
   (prints a page count) and a fake pdftoppm (writes tiny PNGs named as Poppler does: p-1.png, or p-01.png past nine
   pages). The orchestrator is checked with a fake engine, as in its own spec. */

import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PagePreviewService, pageNumberOf, pngSize } from '../src/render/page-preview.service.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

/** A PNG with only its signature and IHDR width and height: all pngSize reads. */
function tinyPng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

let pages = 3
let calls: Array<{ cmd: string; args: string[] }> = []

beforeEach(() => {
  pages = 3
  calls = []
  vi.mocked(spawn).mockImplementation(((cmd: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ cmd, args })
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setImmediate(() => {
      if (cmd === 'pdfinfo') {
        proc.stdout.emit('data', Buffer.from(`Producer: test\nPages:          ${pages}\nPage size: 595 x 842 pts (A4)\n`))
      } else if (cmd === 'pdftoppm') {
        const last = parseInt(args[args.indexOf('-l') + 1], 10)
        const width = String(pages).length
        for (let n = 1; n <= last; n++) writeFileSync(join(opts!.cwd!, `p-${String(n).padStart(width, '0')}.png`), tinyPng(909, 1286))
      }
      proc.emit('close', 0)
    })
    return proc
  }) as unknown as typeof spawn)
})

describe('page preview helpers', () => {
  it('reads a PNG size and refuses what is not a PNG', () => {
    expect(pngSize(tinyPng(120, 80))).toEqual({ widthPx: 120, heightPx: 80 })
    expect(pngSize(Buffer.from('%PDF-1.7'))).toBeNull()
  })

  it('takes the page number after the last dash, padded or not', () => {
    expect(pageNumberOf('p-7.png')).toBe(7)
    expect(pageNumberOf('p-012.png')).toBe(12)
    expect(pageNumberOf('in.pdf')).toBeNull()
  })
})

describe('PagePreviewService', () => {
  it('returns every page, in order, with its size, and the page count', async () => {
    const r = await new PagePreviewService().rasterise(Buffer.from('%PDF-1.7'), { ppi: 110, maxPages: 20 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pageCount).toBe(3)
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(r.pages[0]).toMatchObject({ mime: 'image/png', widthPx: 909, heightPx: 1286 })
    const ppm = calls.find((c) => c.cmd === 'pdftoppm')!
    expect(ppm.args).toEqual(['-png', '-r', '110', '-f', '1', '-l', '3', 'in.pdf', 'p'])
  })

  it('stops at maxPages and still says how many pages the PDF has', async () => {
    pages = 12
    const r = await new PagePreviewService().rasterise(Buffer.from('%PDF-1.7'), { ppi: 72, maxPages: 10 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pageCount).toBe(12)
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('fails, naming previews, when the PDF has no pages', async () => {
    pages = 0
    const r = await new PagePreviewService().rasterise(Buffer.from('%PDF-1.7'), { ppi: 110, maxPages: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ file: 'previews', severity: 'error' })
  })
})
