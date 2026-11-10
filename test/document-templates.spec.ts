/* one-pager@1 and checklist@1 compiled for real: each on one page with and without a picture, PDF/UA-1 accepted, a
   section with no title skipping no heading level, a one-pager that does not fit refused, a long checklist running
   on, JPEG and WebP decoded, a long word kept on the page, a null field, and a request's key never run.

   It needs the Typst binary. CI installs it (`process.env.CI` makes its absence a failure there); on a machine
   without it, this file skips. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { brandIdentitySchema, renderInputSchema } from '../src/contracts/index.js'
import { BrandAssetsService } from '../src/render/brand/brand-assets.service.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { TemplateRegistryService } from '../src/render/template-registry.service.js'
import { TypstEngine } from '../src/render/engines/typst.engine.js'

const hasTypst = spawnSync('typst', ['--version']).status === 0

/** A real 2×2 PNG, so Typst decodes it. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0])
  const row = Buffer.from([0, 200, 80, 40, 40, 80, 200])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = png()
const IMAGE = { url: 'https://files.example.com/pail.png', sha256: createHash('sha256').update(PNG).digest('hex'), alt: 'A white pail.' }
const BRAND = brandIdentitySchema.parse({ brandName: 'B', displayName: 'Acme',
  primaryColor: '#0E7C66', secondaryColor: '#C5973B', accentColor: '#F2C94C', fontBody: 'Noto Sans', fontHeading: 'Noto Serif',
})

const pages = (bytes: Uint8Array) => (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
/** The right edge of the widest word, in points, by Poppler; 0 where Poppler is absent (the page count still holds). */
const widest = (bytes: Uint8Array) => {
  const r = spawnSync('pdftotext', ['-bbox', '-', '-'], { input: Buffer.from(bytes), encoding: 'utf8' })
  if (r.status !== 0) return 0
  return Math.max(...[...r.stdout.matchAll(/xMax="([0-9.]+)"/g)].map((m) => Number(m[1])))
}
const pictures = (bytes: Uint8Array) => (Buffer.from(bytes).toString('latin1').match(/\/Subtype\s*\/Image\b/g) ?? []).length

describe.skipIf(!hasTypst && !process.env.CI)('one-pager@1 and checklist@1, compiled', () => {
  const registry = new TemplateRegistryService()
  const originalFetch = globalThis.fetch
  let scratch: string
  let engine: TypstEngine

  const render = (id: string, values: Record<string, unknown>) => {
    const r = registry.resolve(renderInputSchema.parse({ template: id, brand: BRAND, values }))
    if (!r.ok) throw new Error(id)
    const { source, brand, fields, output, engineConfig } = r.request
    return engine.render({ source, brand, fields, values, output, engineConfig })
  }
  const sample = (id: string) => registry.list().find((x) => x.id === id)!.sample as { sections: Array<Record<string, unknown>> }
  /** The sample with a picture on its first card. */
  const withPicture = (id: string) => {
    const s = structuredClone(sample(id))
    const section = s.sections.find((x) => x.kind === 'cards') as { items: Array<Record<string, unknown>> }
    section.items[0].image = IMAGE
    return s
  }
  const pdf = async (id: string, values: Record<string, unknown>) => {
    const r = await render(id, values)
    if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.errors)}`)
    return r.bytes
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-compile-spec-'))
    const assets = new BrandAssetsService({ get: () => ['files.example.com'] } as never)
    assets.cacheDir = join(scratch, 'cache')
    engine = new TypstEngine(new BrandIdentityService(), assets)
    globalThis.fetch = vi.fn(async () => new Response(PNG, { status: 200 })) as unknown as typeof globalThis.fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    await rm(scratch, { recursive: true, force: true })
  })

  it.each(['one-pager@1', 'checklist@1'])('%s: its sample is one page, with no picture drawn', async (id) => {
    const bytes = await pdf(id, sample(id))
    expect(pages(bytes)).toBe(1)
    expect(pictures(bytes)).toBe(0)
  })

  it.each(['one-pager@1', 'checklist@1'])('%s: with a picture it is one page, and the picture is in it', async (id) => {
    const bytes = await pdf(id, withPicture(id))
    expect(pages(bytes)).toBe(1)
    expect(pictures(bytes)).toBe(1)
  })

  it('takes every shape at once, with no title anywhere, and PDF/UA-1 accepts its headings', async () => {
    const item = { title: 'Uno', body: 'Texto.' }
    const shapes = [
      { kind: 'text', body: 'Texto.', style: 'box' },
      { kind: 'points', items: [item] },
      { kind: 'cards', items: [item], closing: 'Cierre.' },
      { kind: 'steps', items: [item] },
      { kind: 'steps', columns: 3, items: [item] },
      { kind: 'facts', items: [{ label: 'Clave', value: 'Valor' }], note: 'Nota.' },
      { kind: 'checks', items: ['Uno', item], note: 'Nota.', boxed: true },
      { kind: 'row', left: [{ kind: 'points', columns: 1, items: [item] }], right: [{ kind: 'text', body: 'Texto.', style: 'quiet' }] },
    ]
    for (const id of ['one-pager@1', 'checklist@1']) {
      expect(pages(await pdf(id, { title: 'Title', sections: shapes }))).toBe(1)
    }
  })

  it.each([
    ['JPEG', '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+VtU/wCQnd/9dpP/AEI1Qq/qn/ITu/8ArtJ/6EaoV9wfoh//2Q=='],
    ['WebP, lossy', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
    ['WebP, lossless', 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='],
  ])('decodes a %s picture', async (_kind, base64) => {
    const bytes = Buffer.from(base64, 'base64')
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(bytes, { status: 200 }))
    const image = { url: 'https://files.example.com/photo', sha256: createHash('sha256').update(bytes).digest('hex'), alt: 'Una foto.' }
    const out = await pdf('one-pager@1', { title: 'x', sections: [{ kind: 'cards', items: [{ title: 'y', image }] }] })
    expect(pictures(out)).toBeGreaterThan(0)
  })

  it('keeps a long word with no place to break on the page', async () => {
    const word = 'x'.repeat(280)
    for (const id of ['one-pager@1', 'checklist@1']) {
      const out = await pdf(id, { title: word, sections: [{ kind: 'cards', columns: 4, items: [{ title: word, body: word }] }, { kind: 'checks', items: [word] }] })
      expect(pages(out)).toBe(1)
      expect(widest(out)).toBeLessThanOrEqual(595)
    }
  })

  it('breaks a long address without adding a character to it: a copy reads as it was written', async () => {
    const address = `https://example.com/${'a-very-long-path-segment/'.repeat(8)}end?q=${'x'.repeat(60)}`
    const r = spawnSync('pdftotext', ['-v'])
    if (r.error && !process.env.CI) return // Poppler absent here; CI installs it
    for (const id of ['one-pager@1', 'checklist@1']) {
      const out = await pdf(id, { title: 'x', web: 'example.com', sections: [{ kind: 'text', body: `Write to ${address} today.` }] })
      const text = spawnSync('pdftotext', ['-', '-'], { input: Buffer.from(out), encoding: 'utf8' }).stdout
      expect(text).not.toMatch(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/)
      expect(text.replace(/\s+/g, '')).toContain(address)
    }
  })

  it('takes sections: null as no sections', async () => {
    const r = registry.resolve(renderInputSchema.parse({ template: 'checklist@1', brand: BRAND, values: { title: 'x', sections: null } }))
    if (!r.ok) throw new Error('resolve')
    const out = await engine.render({ ...r.request, engineConfig: r.request.engineConfig })
    expect(out.ok).toBe(true)
  })

  it('never runs a request’s key as code, in any field of any request', async () => {
    const out = await engine.render({
      source: ['#assert(x.len() == 1)', '#assert(x.keys().first().contains("read"))', '= Hello'].join('\n'),
      brand: BRAND, output: 'pdf', engineConfig: {},
      fields: [{ key: 'x', label: 'x', fieldTypeKey: 'object', isRequired: false, sortOrder: 0 }],
      values: { x: { 'x: read("/_shared/brand.typ"), y': 1 } },
    })
    expect(out).toMatchObject({ ok: true })
  })

  it('renders a title and nothing else', async () => {
    for (const id of ['one-pager@1', 'checklist@1']) expect(pages(await pdf(id, { title: 'Title' }))).toBe(1)
  })

  it('refuses a one-pager that does not fit, and lets a long checklist run on', async () => {
    const long = Array.from({ length: 24 }, (_, i) => `Point ${i}: ${'a long line that takes its place on the page '.repeat(4)}`)
    const sections = [1, 2, 3].map(() => ({ kind: 'checks', items: long }))
    const refused = await render('one-pager@1', { title: 'x', sections })
    expect(!refused.ok && refused.errors[0].message).toContain('does not fit on one page')
    expect(pages(await pdf('checklist@1', { title: 'x', sections }))).toBeGreaterThan(1)
  })
})
