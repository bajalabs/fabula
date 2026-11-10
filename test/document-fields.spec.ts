/* Typed document fields: the shapes of `sections` and `contact`, what TypstEngine does with them, and the two
   document templates as text.

   Covered: both samples pass their own schemas; a wrong shape is refused before anything is fetched or compiled, the
   error naming the value's path; a card's picture is fetched, placed, and reaches Typst as a file, its URL never does;
   a document without a picture fetches nothing; /data/validate knows the same shapes; an object's keys are strings in
   the Typst literal, never code; a compile that runs too long is killed; the shapes block is one text in both
   templates, no colour is hard-coded, a check hangs beside its box.

   node:child_process.spawn is replaced by a fake that keeps main.typ (the engine removes its work directory); fetch is
   a vitest spy. The compile itself is document-templates.spec.ts. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_LIMITS,
  brandIdentitySchema,
  documentContactSchema,
  documentSectionsSchema,
} from '../src/contracts/index.js'
import { toTypstLiteral } from '../src/util/typst-literal.js'
import { BrandAssetsService } from '../src/render/brand/brand-assets.service.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { DataValidatorService } from '../src/render/data-validator.service.js'
import { documentImages, parseDocumentValues } from '../src/render/document-fields.js'
import { TemplateRegistryService } from '../src/render/template-registry.service.js'
import { TypstEngine } from '../src/render/engines/typst.engine.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

// A PNG's signature and a 2×2 size: all the service reads, since Typst is a fake here
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 2]), Buffer.from('rest')])
const sha = createHash('sha256').update(PNG).digest('hex')
const IMAGE = { url: 'https://files.example.com/pail.png?sig=sekret', sha256: sha, alt: 'A white pail with its printed label.' }
const BRAND = brandIdentitySchema.parse({ brandName: 'B', displayName: 'Acme',
  primaryColor: '#0E7C66', secondaryColor: '#C5973B', fontBody: 'Noto Sans', fontHeading: 'Noto Serif',
})
const registry = new TemplateRegistryService()
const template = (id: string) => {
  const r = registry.list().find((t) => t.id === id)
  if (!r) throw new Error(`no ${id}`)
  return r
}
const fields = template('one-pager@1').fields
const cards = (item: Record<string, unknown>) => [{ kind: 'cards', items: [item] }]

describe("the document templates' samples", () => {
  it.each(['one-pager@1', 'checklist@1'])('%s passes its own fields', (id) => {
    const t = template(id)
    const r = parseDocumentValues(t.fields, t.sample)
    expect(r.ok).toBe(true)
    expect(t.fields.map((f) => f.fieldTypeKey)).toEqual(expect.arrayContaining(['sections', 'contact']))
  })

  it('fills the defaults, so the template can read every key', () => {
    const parsed = documentSectionsSchema.parse([{ kind: 'checks', items: ['uno', { title: 'Dos.', body: 'dos' }] }, { kind: 'text', body: 'x' }])
    expect(parsed[0]).toMatchObject({ columns: 1, boxed: false, items: [{ body: 'uno' }, { title: 'Dos.', body: 'dos' }] })
    expect(parsed[1]).toMatchObject({ style: 'plain' })
  })
})

describe('a wrong shape', () => {
  const refused = (sections: unknown) => parseDocumentValues(fields, { sections })

  it('names the value’s path', () => {
    const r = refused([{ kind: 'text', title: 'x' }, { kind: 'cards', items: [{ title: 'x', image: { ...IMAGE, url: 'http://files.example.com/a.png' } }] }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.every((e) => e.file === 'fields')).toBe(true)
    expect(r.errors.map((e) => e.message.split(':')[0])).toEqual(['sections.0.body', 'sections.1.items.0.image.url'])
  })

  it('refuses an unknown kind, an unknown key and more than the limits', () => {
    expect(refused([{ kind: 'gallery', items: [] }]).ok).toBe(false)
    expect(refused([{ kind: 'text', body: 'x', 'a: 1, b': 'y' }]).ok).toBe(false)
    expect(refused(Array.from({ length: DOCUMENT_LIMITS.sections + 1 }, () => ({ kind: 'text', body: 'x' }))).ok).toBe(false)
  })

  it('takes a picture only with its sha256 and alt, and never a path of its own', () => {
    expect(refused(cards({ title: 'x', image: { url: IMAGE.url, sha256: sha } })).ok).toBe(false)
    expect(refused(cards({ title: 'x', image: { ...IMAGE, sha256: '../../etc/passwd' } })).ok).toBe(false)
    expect(refused(cards({ title: 'x', image: { ...IMAGE, path: '/_shared/brand.typ' } })).ok).toBe(false)
  })

  it('counts pictures across the document, rows included', () => {
    const many = Array.from({ length: DOCUMENT_LIMITS.images + 1 }, (_, i) => ({ title: `c${i}`, image: IMAGE }))
    const r = refused([{ kind: 'row', left: [{ kind: 'cards', items: many.slice(0, 6) }], right: [{ kind: 'cards', items: many.slice(6) }] }])
    expect(!r.ok && r.errors[0].message).toContain(`at most ${DOCUMENT_LIMITS.images} images`)
  })

  it('wants a contact’s button whole, and on https', () => {
    expect(documentContactSchema.safeParse({ title: 'x' }).success).toBe(true)
    expect(documentContactSchema.safeParse({ title: 'x', cta_label: 'y' }).success).toBe(false)
    expect(documentContactSchema.safeParse({ title: 'x', cta_label: 'y', cta_url: 'http://example.mx' }).success).toBe(false)
  })

  it('leaves a field that is not typed alone', () => {
    const listField = { key: 'points', label: 'Points', fieldTypeKey: 'array', isRequired: false, sortOrder: 0 }
    const r = parseDocumentValues([listField], { points: [{ anything: true }] })
    expect(r).toEqual({ ok: true, values: { points: [{ anything: true }] } })
  })

  it('answers the same at /data/validate', () => {
    const v = new DataValidatorService()
    expect(v.validate({ fields, values: { title: 'x', sections: [{ kind: 'text', body: 'x' }] } }).ok).toBe(true)
    const bad = v.validate({ fields, values: { title: 'x', sections: [{ kind: 'text' }] } })
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].path).toEqual(['sections', '0', 'body'])
  })
})

describe('toTypstLiteral', () => {
  it('writes an object’s keys as strings, whatever they hold', () => {
    expect(toTypstLiteral({ title: 'x' })).toBe('("title": "x")')
    expect(toTypstLiteral({ 'x: read("/etc/passwd"), y': 1 })).toBe(String.raw`("x: read(\"/etc/passwd\"), y": 1)`)
    expect(toTypstLiteral([{ 'a\\': { 'b"': 2 } }])).toBe(String.raw`(("a\\": ("b\"": 2)),)`)
  })
})

describe('documentImages', () => {
  it('finds each card’s picture in reading order, inside rows too', () => {
    const r = parseDocumentValues(fields, {
      sections: [
        { kind: 'cards', items: [{ title: 'a' }, { title: 'b', image: IMAGE }] },
        { kind: 'row', left: [{ kind: 'text', body: 'x' }], right: [{ kind: 'cards', items: [{ title: 'c', image: IMAGE }] }] },
      ],
    })
    if (!r.ok) throw new Error('parse')
    expect(documentImages(fields, r.values).map((i) => i.where)).toEqual(['sections.0.items.1', 'sections.1.right.0.items.0'])
  })
})

describe('TypstEngine with a document', () => {
  let scratch: string
  let main: string
  let images: boolean
  const originalFetch = globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  const engine = () => {
    const assets = new BrandAssetsService({ get: () => ['files.example.com'] } as never)
    assets.cacheDir = join(scratch, 'cache')
    return new TypstEngine(new BrandIdentityService(), assets)
  }
  const render = (id: string, values: Record<string, unknown>) => {
    const t = template(id)
    return engine().render({ source: '= x', brand: BRAND, fields: t.fields, values, output: 'pdf', engineConfig: {} })
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-documents-spec-'))
    main = ''
    images = false
    fetchSpy = vi.fn(async () => new Response(PNG, { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const workDir = args[args.indexOf('--root') + 1]
      main = readFileSync(join(workDir, 'main.typ'), 'utf-8')
      images = existsSync(join(workDir, '_shared/images', `${sha}.png`))
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('%PDF'))
        proc.emit('close', 0)
      })
      return proc
    }) as unknown as typeof spawn)
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    vi.mocked(spawn).mockReset()
    await rm(scratch, { recursive: true, force: true })
  })

  it.each(['one-pager@1', 'checklist@1'])('%s: a card’s picture reaches Typst as a file, never as its URL', async (id) => {
    const r = await render(id, { title: 'x', sections: cards({ title: 'Pail', image: IMAGE }) })
    expect(r.ok).toBe(true)
    expect(images).toBe(true)
    expect(main).toContain(`"path": "/_shared/images/${sha}.png"`)
    expect(main).toContain(`"alt": "${IMAGE.alt}"`)
    expect(main).not.toContain('files.example.com')
    expect(main).not.toContain('sekret')
  })

  it.each(['one-pager@1', 'checklist@1'])('%s: with no picture nothing is fetched and nothing stands in for it', async (id) => {
    const r = await render(id, { title: 'x', sections: cards({ title: 'Pail' }) })
    expect(r.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(images).toBe(false)
    expect(main).not.toContain('"image"')
  })

  it('refuses a wrong shape before it fetches or compiles', async () => {
    const r = await render('one-pager@1', { title: 'x', sections: [{ kind: 'nope' }] })
    expect(!r.ok && r.errors[0].file).toBe('fields')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails the render when a picture does not verify, naming the value', async () => {
    const r = await render('one-pager@1', { title: 'x', sections: cards({ title: 'Pail', image: { ...IMAGE, sha256: 'a'.repeat(64) } }) })
    expect(!r.ok && r.errors[0]).toMatchObject({ file: 'fields' })
    expect(!r.ok && r.errors[0].message).toContain('sections.0.items.0')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('stops a compile that runs too long, and says so', async () => {
    const kill = vi.fn()
    vi.mocked(spawn).mockImplementation((() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: typeof kill }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = kill
      return proc
    }) as unknown as typeof spawn)
    const e = engine()
    e.compileTimeoutMs = 10
    const t = template('checklist@1')
    const r = await e.render({ source: '= x', brand: BRAND, fields: t.fields, values: {}, output: 'pdf', engineConfig: {} })
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(!r.ok && r.errors[0].message).toContain('typst compile stopped')
  })

  it('leaves a request without typed fields as it was', async () => {
    const listField = { key: 'items', label: 'Items', fieldTypeKey: 'array', isRequired: false, sortOrder: 0 }
    const r = await engine().render({ source: '= x', brand: BRAND, fields: [listField], values: { items: ['one'] }, output: 'pdf', engineConfig: {} })
    expect(r.ok).toBe(true)
    expect(main).toContain('#let items = ("one",)')
  })
})

describe("the document templates' sources", () => {
  const source = (rel: string) => readFileSync(join(process.cwd(), 'templates', rel), 'utf-8')
  const one = source('document/one-pager/v1/main.typ')
  const check = source('document/checklist/v1/main.typ')
  const shapes = (s: string) => s.slice(s.indexOf('// ── The section shapes'), s.indexOf('// ── End of the section shapes'))

  it('carry the same section shapes: a template version stands alone, so the block is copied and held together here', () => {
    expect(shapes(one).length).toBeGreaterThan(1000)
    expect(shapes(one)).toBe(shapes(check))
  })

  it('hard-code no colour: text on a fill is the brand’s on-colour', () => {
    for (const s of [one, check]) {
      expect(s).not.toMatch(/\bwhite\b|\bblack\b|rgb\(/)
      expect(s).toContain('fill: brand-on-primary')
      expect(s).toContain('fill: brand-on-accent')
      expect(s).toContain('fill: brand-heading')
    }
  })

  it('hang a check beside its box: the box and the text are two columns', () => {
    expect(check).toMatch(/#let check\(item\) = grid\(\s*columns: \(5\.5mm, 1fr\),/)
  })
})
