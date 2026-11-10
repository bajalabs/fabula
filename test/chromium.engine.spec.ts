/* ChromiumEngine. Without a browser: a request's URL is a file of the render's folder only on the render's own origin
   and inside the folder (no `..`, encoded or not, no other host or scheme); engineConfig is checked; a screenshot is
   held to 40 million pixels; scripts are switched off before the page opens, and every request is answered (a fake
   browser records the calls). With a browser (FABULA_CHROMIUM_PATH, Google Chrome on a Mac, or chromium on the PATH;
   skipped where there is none, as in CI's test job): a PNG of the viewport's size, a PDF, and a page whose outside
   resources are refused and named in the warnings. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { BrandAssetsService } from '../src/render/brand/brand-assets.service.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import type { CdpClient, CdpHandler, CdpParams } from '../src/render/engines/cdp.js'
import {
  answerRequest,
  ChromiumEngine,
  chromiumConfigSchema,
  RENDER_ORIGIN,
  renderPath,
  screenshotPixels,
  SCREENSHOT_MAX_PIXELS,
} from '../src/render/engines/chromium.engine.js'

const BRAND = brandIdentitySchema.parse({})
const engine = () => new ChromiumEngine(new BrandIdentityService(), new BrandAssetsService({ get: () => [] } as never))
const request = (source: string, output: 'png' | 'jpeg' | 'pdf', engineConfig: Record<string, unknown> = {}) => ({
  source,
  brand: BRAND,
  fields: [],
  values: {},
  output,
  engineConfig,
})

describe('renderPath', () => {
  const root = '/srv/render/site'

  it('serves a file of the folder on the render’s origin', () => {
    expect(renderPath(`${RENDER_ORIGIN}/main.html`, root)).toEqual({ ok: true, path: '/srv/render/site/main.html' })
    expect(renderPath(`${RENDER_ORIGIN}/_shared/fonts/a%20b.woff2?x=1`, root)).toEqual({ ok: true, path: '/srv/render/site/_shared/fonts/a b.woff2' })
  })

  it('never leaves the folder, however a path is spelled', () => {
    // The URL parser folds `..` and `%2e%2e` away, so these name a file inside the folder (a 404 there)
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect(renderPath(`${RENDER_ORIGIN}${path}`, root)).toEqual({ ok: true, path: '/srv/render/site/etc/passwd' })
    }
    // An encoded slash, a dot folder, a NUL, a backslash or the folder itself is refused
    for (const path of ['/a/..%2f..%2f..%2fetc/passwd', '/.profile/Cookies', '/%00x', '/a%5c..%5cb', '/']) {
      expect(renderPath(`${RENDER_ORIGIN}${path}`, root).ok, path).toBe(false)
    }
  })

  it('refuses another host or scheme, naming only the scheme and host', () => {
    expect(renderPath('https://example.com/secret/path?token=x', root)).toEqual({ ok: false, label: 'https://example.com' })
    expect(renderPath('http://127.0.0.1:1/x.css', root)).toEqual({ ok: false, label: 'http://127.0.0.1:1' })
    expect(renderPath('file:///etc/hosts', root)).toEqual({ ok: false, label: 'file:' })
    expect(renderPath('http://render.fabula.invalid/main.html', root).ok).toBe(false)
  })
})

describe('engineConfig and the pixel bound', () => {
  it('fills the defaults and refuses anything else', () => {
    expect(chromiumConfigSchema.parse({})).toEqual({ viewport: { width: 1200, height: 630, deviceScaleFactor: 2 }, quality: 90, fullPage: false })
    for (const bad of [{ viewport: { width: 0, height: 10 } }, { viewport: { width: 9000, height: 10 } }, { quality: 101 }, { fullPage: 'yes' }, { script: true }]) {
      expect(chromiumConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('counts a screenshot’s pixels at its scale', () => {
    expect(screenshotPixels(1200, 630, 2)).toBe(2400 * 1260)
    expect(screenshotPixels(8192, 8192, 1)).toBeGreaterThan(SCREENSHOT_MAX_PIXELS)
  })

  it('refuses a viewport past the bound, a bad engineConfig, PDF/UA, and an output it has not', async () => {
    const e = engine()
    expect(await e.render(request('<p>x</p>', 'png', { viewport: { width: 8192, height: 8192, deviceScaleFactor: 1 } }))).toMatchObject({ ok: false, errors: [{ file: 'engineConfig' }] })
    expect(await e.render(request('<p>x</p>', 'png', { quality: 0 }))).toMatchObject({ ok: false, errors: [{ file: 'engineConfig' }] })
    expect(await e.render(request('<p>x</p>', 'pdf', { pdf: { standards: ['ua-1'] } }))).toMatchObject({ ok: false, errors: [{ file: 'engineConfig' }] })
    expect((await e.render({ ...request('<p>x</p>', 'png'), output: 'html' })).ok).toBe(false)
  })

  it('answers a list in a {{ key }} as a field error', async () => {
    const r = await engine().render({ ...request('<p>{{ rows }}</p>', 'png'), fields: [{ key: 'rows', label: 'Rows', fieldTypeKey: 'array', isRequired: false, sortOrder: 0 }], values: { rows: [1] } })
    expect(r).toMatchObject({ ok: false, errors: [{ file: 'fields' }] })
  })
})

/** A browser that records the calls and answers with what a real one would. */
function fakeBrowser() {
  const calls: Array<{ method: string; params: CdpParams; sessionId?: string }> = []
  const handlers = new Map<string, CdpHandler[]>()
  const emit = (event: string, params: CdpParams) => {
    for (const h of handlers.get(event) ?? []) h(params, 'S')
  }
  const client: CdpClient = {
    timedOut: false,
    async send<T>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
      calls.push({ method, params, sessionId })
      if (method === 'Target.createTarget') return { targetId: 'T' } as T
      if (method === 'Target.attachToTarget') return { sessionId: 'S' } as T
      if (method === 'Page.navigate') {
        queueMicrotask(() => {
          emit('Fetch.requestPaused', { requestId: 'r1', request: { url: `${RENDER_ORIGIN}/main.html`, method: 'GET' } })
          emit('Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://example.com/x.png?sig=s', method: 'GET' } })
          setTimeout(() => {
            emit('Page.loadEventFired', {})
            emit('Page.lifecycleEvent', { name: 'networkIdle' })
          }, 20)
        })
        return {} as T
      }
      if (method === 'Page.captureScreenshot' || method === 'Page.printToPDF') return { data: Buffer.from('bytes').toString('base64') } as T
      return {} as T
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    async close() {},
  }
  return { client, calls }
}

describe('the page’s session, with a fake browser', () => {
  it('switches scripts off and intercepts every request before the page opens', async () => {
    const { client, calls } = fakeBrowser()
    const e = engine()
    e.launch = () => client
    const r = await e.render(request('<p>x</p>', 'png'))
    expect(r.ok).toBe(true)
    const order = calls.map((c) => c.method)
    expect(order.indexOf('Emulation.setScriptExecutionDisabled')).toBeLessThan(order.indexOf('Page.navigate'))
    expect(order.indexOf('Fetch.enable')).toBeLessThan(order.indexOf('Page.navigate'))
    expect(calls.find((c) => c.method === 'Emulation.setScriptExecutionDisabled')?.params).toEqual({ value: true })
    expect(calls.find((c) => c.method === 'Fetch.enable')?.params).toEqual({ patterns: [{ urlPattern: '*' }] })
    expect(calls.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: `${RENDER_ORIGIN}/main.html` })
    expect(calls.find((c) => c.method === 'Fetch.failRequest')?.params).toEqual({ requestId: 'r2', errorReason: 'BlockedByClient' })
    expect(r.ok && r.warnings).toEqual([{ severity: 'warning', message: 'a resource outside the render was not loaded: https://example.com' }])
  })
})

describe('answerRequest', () => {
  let root: string
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'fabula-chromium-answer-')))
    await mkdir(join(root, 'site'))
    await writeFile(join(root, 'site', 'main.html'), '<p>x</p>')
    await writeFile(join(root, 'secret.css'), 'body{}')
    await symlink(join(root, 'secret.css'), join(root, 'site', 'link.css'))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const answer = async (url: string, method = 'GET') => {
    const { client, calls } = fakeBrowser()
    const refused = new Set<string>()
    const outcome = await answerRequest(client, 'S', { requestId: 'r', request: { url, method } }, join(root, 'site'), refused)
    return { outcome, calls, refused }
  }

  it('serves a file of the folder with its type, and a 404 for one that is not there', async () => {
    const served = await answer(`${RENDER_ORIGIN}/main.html`)
    expect(served.outcome).toBe('served')
    expect(served.calls[0].params).toMatchObject({ responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] })
    expect((await answer(`${RENDER_ORIGIN}/nope.png`)).outcome).toBe('missing')
  })

  it('refuses a link out of the folder, a write, and another origin', async () => {
    expect((await answer(`${RENDER_ORIGIN}/link.css`)).outcome).toBe('refused')
    expect((await answer(`${RENDER_ORIGIN}/main.html`, 'POST')).outcome).toBe('refused')
    const other = await answer('https://example.com/x.png')
    expect(other.outcome).toBe('refused')
    expect([...other.refused]).toEqual(['https://example.com'])
  })
})

function findBrowser(): string | null {
  if (process.env.FABULA_CHROMIUM_PATH) return process.env.FABULA_CHROMIUM_PATH
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (process.platform === 'darwin' && existsSync(mac)) return mac
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome']) {
    if (spawnSync(bin, ['--version']).status === 0) return bin
  }
  return null
}

const browser = findBrowser()

describe.skipIf(!browser)('with a real browser', () => {
  const real = () => {
    const e = engine()
    e.binary = browser!
    e.timeoutMs = 30_000
    return e
  }
  const pngSize = (b: Uint8Array) => ({ width: Buffer.from(b).readUInt32BE(16), height: Buffer.from(b).readUInt32BE(20) })

  it('writes a PNG of the viewport at its scale', async () => {
    const r = await real().render(request('<h1 style="color:#0E7C66">Hello</h1>', 'png', { viewport: { width: 400, height: 200, deviceScaleFactor: 2 } }))
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true)
    if (!r.ok) return
    expect(r.mime).toBe('image/png')
    expect(Buffer.from(r.bytes).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(pngSize(r.bytes)).toEqual({ width: 800, height: 400 })
  }, 40_000)

  it('writes a JPEG and a PDF', async () => {
    const jpeg = await real().render(request('<p>Hello</p>', 'jpeg', { viewport: { width: 200, height: 100, deviceScaleFactor: 1 }, quality: 70 }))
    expect(jpeg.ok && Buffer.from(jpeg.bytes).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const pdf = await real().render(request('<h1>Report</h1><p>Body</p>', 'pdf'))
    expect(pdf.ok && pdf.mime).toBe('application/pdf')
    expect(pdf.ok && Buffer.from(pdf.bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 60_000)

  it('refuses every resource from outside the render, and names its host in a warning', async () => {
    const page = [
      '<link rel="stylesheet" href="http://127.0.0.1:1/x.css">',
      '<img src="https://example.com/x.png?token=secret">',
      '<img src="file:///etc/hosts">',
      '<iframe src="file:///etc/passwd"></iframe>',
      '<p>Outside</p>',
    ].join('\n')
    const r = await real().render(request(page, 'png', { viewport: { width: 300, height: 200, deviceScaleFactor: 1 } }))
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true)
    const messages = (r.ok && r.warnings ? r.warnings : []).map((w) => w.message)
    expect(messages).toContain('a resource outside the render was not loaded: https://example.com')
    expect(messages.join(' ')).not.toContain('secret')
    expect(messages.join(' ')).not.toContain('/etc/')
  }, 40_000)

  it('runs no script: a page that would rewrite itself keeps its own size', async () => {
    const source = '<div style="height:50px">x</div><script>document.body.innerHTML = "<div style=\\"height:3000px\\"></div>"</script>'
    const r = await real().render(request(source, 'png', { viewport: { width: 200, height: 100, deviceScaleFactor: 1 }, fullPage: true }))
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true)
    expect(r.ok && pngSize(r.bytes).height).toBeLessThan(3000)
  }, 40_000)
})
