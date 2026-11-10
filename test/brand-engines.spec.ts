/* Engines and the brand: what each subprocess engine writes into its work directory and passes on its command line.

   Covered: Typst: files under _shared/, --font-path, brand.typ's logo path; a plain request keeps its exact
   arguments. A bad asset fails the render before anything is spawned. Pandoc: --pdf-engine-opt=--font-path and the
   brand's fonts as variables for PDF; nothing fetched for HTML. Quarto: _brand.yml, the font folder in _quarto.yml's
   typst format and TYPST_FONT_PATHS. WeasyPrint: @font-face pointing at files beside main.html.

   node:child_process.spawn is replaced by a fake that snapshots the work directory (the engine removes it after) and
   exits 0 with fake output; fetch is a vitest spy. Real rendering is the image drill's job (scripts/engine-drill.sh). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import {
  brandIdentitySchema,
  type BrandIdentity,
} from '../src/contracts/index.js'
import type { EngineRenderRequest } from '../src/contracts/engine.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { BrandAssetsService } from '../src/render/brand/brand-assets.service.js'
import { TypstEngine } from '../src/render/engines/typst.engine.js'
import { PandocEngine } from '../src/render/engines/pandoc.engine.js'
import { QuartoEngine } from '../src/render/engines/quarto.engine.js'
import { WeasyPrintEngine } from '../src/render/engines/weasyprint.engine.js'

// Hoisted by Vitest above the imports: every engine gets the fake
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const TTF = Buffer.from('ttf bytes')
const WOFF2 = Buffer.from('woff2 bytes')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const ASSET_HOSTS = ['files.example.com']
const FILES: Record<string, Buffer> = {
  'https://files.example.com/inter.ttf?sig=1': TTF,
  'https://files.example.com/inter.woff2?sig=1': WOFF2,
  'https://files.example.com/logo.svg?sig=1': SVG,
}

const LEGACY = {
  brandName: 'Acme',
  displayName: 'Acme',
  primaryColor: '#111111',
  secondaryColor: '#222222',
  fontBody: 'Noto Sans',
  fontHeading: 'Noto Serif',
}

const RECORD = {
  ...LEGACY,
  colors: [{ token: 'primary', hex: '#0E7C66' }],
  fonts: [
    { role: 'body', family: 'Inter', format: 'ttf', url: 'https://files.example.com/inter.ttf?sig=1', sha256: sha(TTF) },
    { role: 'body', family: 'Inter', format: 'woff2', url: 'https://files.example.com/inter.woff2?sig=1', sha256: sha(WOFF2) },
  ],
  logos: [
    { variant: 'primary', mode: 'light', format: 'svg', url: 'https://files.example.com/logo.svg?sig=1', sha256: sha(SVG) },
  ],
}

function request(brand: BrandIdentity, output: EngineRenderRequest['output'], source = ''): EngineRenderRequest {
  return { source, brand, fields: [], values: {}, output, engineConfig: {} }
}

interface SpawnCall {
  cmd: string
  args: string[]
  env?: NodeJS.ProcessEnv
  workDir: string
  /** Every file in the work directory, relative, at spawn time. */
  files: string[]
  /** A file's text as it was at spawn time ('' when absent). */
  read(rel: string): string
}

function listFiles(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? listFiles(root, p) : [relative(root, p)]
  })
}

describe('engines × brand record', () => {
  let scratch: string
  let assets: BrandAssetsService
  let calls: SpawnCall[]
  const identity = new BrandIdentityService()
  const originalFetch = globalThis.fetch
  const originalPkgCache = process.env.TYPST_PACKAGE_CACHE_PATH

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-engines-spec-'))
    assets = new BrandAssetsService({ get: () => ASSET_HOSTS } as never)
    assets.cacheDir = join(scratch, 'cache')
    delete process.env.TYPST_PACKAGE_CACHE_PATH
    globalThis.fetch = vi.fn(async (input: URL | string) => {
      const body = FILES[String(input)]
      return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch

    calls = []
    vi.mocked(spawn).mockImplementation(((cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const workDir =
        opts?.cwd ??
        (cmd === 'typst' ? args[args.indexOf('--root') + 1] : dirname(args[0]))
      const files = listFiles(workDir)
      const contents = new Map(files.map((f) => [f, readFileSync(join(workDir, f), 'utf-8')]))
      calls.push({
        cmd,
        args,
        env: opts?.env,
        workDir,
        files,
        read: (rel) => contents.get(rel) ?? '',
      })
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = () => {}
      setImmediate(() => {
        if (cmd === 'quarto') {
          const to = args[args.indexOf('--to') + 1]
          writeFileSync(join(workDir, `main.${to === 'html' ? 'html' : 'pdf'}`), '%PDF-fake')
        } else if (cmd === 'python3' && args[0].endsWith('weasyprint-render.py')) {
          writeFileSync(args[2], '%PDF-fake')
        } else {
          proc.stdout.emit('data', Buffer.from('%PDF-fake'))
        }
        proc.emit('close', 0)
      })
      return proc
    }) as unknown as typeof spawn)
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalPkgCache === undefined) delete process.env.TYPST_PACKAGE_CACHE_PATH
    else process.env.TYPST_PACKAGE_CACHE_PATH = originalPkgCache
    vi.mocked(spawn).mockReset()
    await rm(scratch, { recursive: true, force: true })
  })

  describe('TypstEngine', () => {
    it('keeps the exact arguments for a legacy request', async () => {
      const engine = new TypstEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(LEGACY), 'pdf', '= Hello'))
      expect(res.ok).toBe(true)
      const [call] = calls
      expect(call.args).toEqual(['compile', join(call.workDir, 'main.typ'), '-', '--root', call.workDir])
      expect(call.files.sort()).toEqual(['_shared/brand.typ', 'main.typ'])
      expect(existsSync(call.workDir)).toBe(false) // removed after the render
    })

    it('places the record files and passes --font-path', async () => {
      const engine = new TypstEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(RECORD), 'pdf'))
      expect(res.ok).toBe(true)
      const [call] = calls
      const fontDir = join(call.workDir, '_shared/fonts')
      expect(call.args.slice(-2)).toEqual(['--font-path', fontDir])
      // ttf only: Typst cannot read the woff2
      expect(call.files.sort()).toEqual([
        '_shared/brand.typ',
        `_shared/fonts/${sha(TTF)}.ttf`,
        '_shared/logos/primary-light.svg',
        'main.typ',
      ])
      const typ = call.read('_shared/brand.typ')
      expect(typ).toContain('"primary/light": "/_shared/logos/primary-light.svg",')
      expect(typ).toContain('#let font-body    = "Inter"')
      expect(typ).toContain('#let brand-primary   = rgb("#0E7C66")')
    })

    it('fails before spawning when an asset does not verify', async () => {
      const bad = { ...RECORD, logos: [{ ...RECORD.logos[0], sha256: 'f'.repeat(64) }] }
      const engine = new TypstEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(bad), 'pdf'))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.errors[0].message).toMatch(/^brand logo \(variant primary, mode light, svg\): sha256 mismatch/)
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  describe('PandocEngine', () => {
    it('hands the font folder to Typst and the record fonts to the template', async () => {
      const engine = new PandocEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(RECORD), 'pdf', '# Hello'))
      expect(res.ok).toBe(true)
      const [call] = calls
      expect(call.args).toContain('--pdf-engine=typst')
      expect(call.args).toContain('mainfont=Inter')
      expect(call.args).toContain('sansfont=Noto Serif')
      expect(call.args).toContain('header-includes=#show heading: set text(font: "Noto Serif")')
      expect(call.args).toContain(`--pdf-engine-opt=--font-path=${join(call.workDir, '_shared/fonts')}`)
      expect(call.files).toContain(`_shared/fonts/${sha(TTF)}.ttf`)
    })

    it('runs a plain PDF request in its sandbox, with the brand fonts as variables', async () => {
      const engine = new PandocEngine(identity, assets)
      await engine.render(request(brandIdentitySchema.parse(LEGACY), 'pdf', '# Hello'))
      const [call] = calls
      expect(call.args).toEqual([
        '--sandbox',
        join(call.workDir, 'main.md'),
        '--from=markdown+raw_attribute',
        '--to=pdf',
        '--pdf-engine=typst',
        '--variable',
        'mainfont=Noto Sans',
        '--variable',
        'sansfont=Noto Serif',
        '--variable',
        'header-includes=#show heading: set text(font: "Noto Serif")',
        '--output=-',
      ])
    })

    it('fetches nothing for HTML output', async () => {
      const engine = new PandocEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(RECORD), 'html', '# Hello'))
      expect(res.ok).toBe(true)
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(calls[0].args.some((a) => a.includes('font-path'))).toBe(false)
    })
  })

  describe('QuartoEngine', () => {
    const LEGACY_QUARTO_YML = [
      'project:',
      '  type: default',
      'format:',
      '  typst:',
      '    keep-typ: false',
      '  html:',
      '    embed-resources: true',
      'execute:',
      '  enabled: false',
      '  cache: false',
      '',
    ].join('\n')

    it('writes the same _quarto.yml and no _brand.yml for a legacy request', async () => {
      const engine = new QuartoEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(LEGACY), 'pdf', 'Hello'))
      expect(res.ok).toBe(true)
      const [call] = calls
      expect(call.read('_quarto.yml')).toBe(LEGACY_QUARTO_YML)
      expect(call.files).not.toContain('_brand.yml')
      expect(call.env?.TYPST_FONT_PATHS).toBeUndefined()
    })

    it('writes _brand.yml and points Typst at the font folder', async () => {
      const engine = new QuartoEngine(identity, assets)
      const res = await engine.render(request(brandIdentitySchema.parse(RECORD), 'pdf', 'Hello'))
      expect(res.ok).toBe(true)
      const [call] = calls
      const fontDir = join(call.workDir, '_shared/fonts')
      expect(call.files).toContain('_brand.yml')
      expect(call.read('_brand.yml')).toContain(`path: _shared/fonts/${sha(TTF)}.ttf`)
      const yml = call.read('_quarto.yml')
      expect(yml).toContain(`  typst:\n    keep-typ: false\n    font-paths:\n      - ${JSON.stringify(fontDir)}\n`)
      expect(yml.match(/^ {2}typst:$/gm)).toHaveLength(1)
      expect(call.env?.TYPST_FONT_PATHS).toBe(fontDir)
    })

    it('takes WOFF2 for an HTML page', async () => {
      const engine = new QuartoEngine(identity, assets)
      await engine.render(request(brandIdentitySchema.parse(RECORD), 'html', 'Hello'))
      expect(calls[0].files).toContain(`_shared/fonts/${sha(WOFF2)}.woff2`)
      expect(calls[0].files).not.toContain(`_shared/fonts/${sha(TTF)}.ttf`)
    })
  })

  describe('every engine process', () => {
    it('gets no secret of the service and a proxy that answers nothing', async () => {
      process.env.FABULA_HMAC_KEYS = '{"leak":"' + 'ab'.repeat(32) + '"}'
      try {
        const brand = brandIdentitySchema.parse(LEGACY)
        await new TypstEngine(identity, assets).render(request(brand, 'pdf', '= Hello'))
        await new PandocEngine(identity, assets).render(request(brand, 'pdf', '# Hello'))
        await new QuartoEngine(identity, assets).render(request(brand, 'pdf', 'Hello'))
        await new WeasyPrintEngine(identity, assets).render(request(brand, 'pdf', '<p>Hello</p>'))
      } finally {
        delete process.env.FABULA_HMAC_KEYS
      }
      expect(calls.map((c) => c.cmd)).toEqual(['typst', 'pandoc', 'quarto', 'python3'])
      for (const call of calls) {
        expect(Object.keys(call.env ?? {}).filter((k) => k.startsWith('FABULA_')), call.cmd).toEqual([])
        expect(call.env?.HTTPS_PROXY, call.cmd).toBe('http://127.0.0.1:9')
        expect(call.env?.https_proxy, call.cmd).toBe('http://127.0.0.1:9')
      }
    })

    it('runs WeasyPrint through the wrapper that confines its URL fetcher', async () => {
      await new WeasyPrintEngine(identity, assets).render(request(brandIdentitySchema.parse(LEGACY), 'pdf', '<p>Hello</p>'))
      expect(calls[0].args[0]).toMatch(/scripts\/weasyprint-render\.py$/)
      expect(calls[0].args.slice(1, 3)).toEqual([join(calls[0].workDir, 'main.html'), join(calls[0].workDir, 'main.pdf')])
    })
  })

  describe('WeasyPrintEngine', () => {
    it('links the stylesheet to files beside main.html', async () => {
      const engine = new WeasyPrintEngine(identity, assets)
      const res = await engine.render(
        request(brandIdentitySchema.parse(RECORD), 'pdf', '<p class="brand-logo"></p>'),
      )
      expect(res.ok).toBe(true)
      const [call] = calls
      const html = call.read('main.html')
      expect(html).toContain(`src: url("_shared/fonts/${sha(TTF)}.ttf") format("truetype");`)
      expect(html).toContain('--brand-logo:      url("_shared/logos/primary-light.svg");')
      expect(call.files).toContain(`_shared/fonts/${sha(TTF)}.ttf`)
      expect(call.files).toContain('_shared/logos/primary-light.svg')
    })
  })
})
