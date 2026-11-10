/* ChromiumEngine: HTML and CSS to PNG, JPEG or PDF with headless Chromium, driven over the DevTools protocol (cdp.ts).

   The page is composed as in WeasyPrintEngine ({{ key }} values HTML-escaped, the brand stylesheet in <head>, the
   brand's files beside main.html) and then rendered under these rules:

     • Scripts are off (Emulation.setScriptExecutionDisabled) before the page is opened.
     • Every request the page makes is answered by Fabula. The page is opened as https://render.fabula.invalid/main.html
       and Fetch intercepts every request: a GET to that origin is served from the render's own folder (the path
       normalised, kept inside the folder, its real path checked against links), anything else (another host, another
       scheme, a path outside) is refused. A refused resource is a warning naming its scheme and host, never its path
       or query. The browser cannot open file: URLs from an https page, and a proxy that answers nothing and a resolver
       that resolves nothing stand behind the interception.
     • Chromium runs with --no-sandbox: its own sandbox needs privileges a container does not give, so the container is
       the sandbox. Each render starts its own browser with a throwaway profile, and one deadline (timeoutMs) kills it.

   engineConfig: { viewport?: { width, height, deviceScaleFactor }, quality?, fullPage?, pdf? }. A screenshot is at
   most FABULA_IMAGE_MAX_PIXELS (40 million). A PDF is tagged; Chromium writes no PDF/UA or PDF/A, so asking for one is
   refused. HTML to PDF goes to WeasyPrint unless the request sets engineConfig.engine to "chromium". */

import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, posix, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { CompileError, OutputType, RenderFormat } from '../../contracts/index.js'
import type { EngineRenderRequest, EngineRenderResult, RenderEngine } from '../../contracts/engine.js'
import { readPdfOptions } from '../../contracts/pdf-options.js'
import { BrandIdentityService } from '../brand/brand-identity.service.js'
import { BrandAssetsService, WEB_HTML_ASSET_FORMATS } from '../brand/brand-assets.service.js'
import { substitute, TemplateValueError } from '../../util/mustache.js'
import { CdpError, launchChromium, type CdpClient, type CdpParams, type LaunchOptions } from './cdp.js'
import { settings } from '../../config/settings.js'
import { engineEnv } from './subprocess.js'

export const RENDER_ORIGIN = 'https://render.fabula.invalid'
/** The default bound; the running one is FABULA_IMAGE_MAX_PIXELS. */
export const SCREENSHOT_MAX_PIXELS = 40_000_000
/** After the load event, how long the page may stay busy (fonts, images) before the capture. */
const SETTLE_MS = 2_000

export const chromiumConfigSchema = z
  .object({
    viewport: z
      .object({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
        deviceScaleFactor: z.number().positive().max(4).default(2),
      })
      .strict()
      .default({ width: 1200, height: 630, deviceScaleFactor: 2 }),
    quality: z.number().int().min(1).max(100).default(90),
    fullPage: z.boolean().default(false),
    pdf: z.unknown().optional(), // read by readPdfOptions
  })
  .strict()

export type ChromiumConfig = z.infer<typeof chromiumConfigSchema>

/** Pixels a capture of `width` × `height` CSS pixels writes at `scale`. */
export const screenshotPixels = (width: number, height: number, scale: number): number =>
  Math.ceil(width * scale) * Math.ceil(height * scale)

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export type RenderPath = { ok: true; path: string } | { ok: false; label: string }

/** A request's URL as a file of the render's folder `root`, or the scheme and host it was refused for. */
export function renderPath(raw: string, root: string): RenderPath {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, label: 'a URL that does not parse' }
  }
  const label = url.host ? `${url.protocol}//${url.host}` : url.protocol
  if (url.origin !== RENDER_ORIGIN) return { ok: false, label }
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return { ok: false, label }
  }
  // Decoded, a segment may not climb or be hidden (an encoded slash makes `..%2f` one): refused, not folded away
  if (path.includes('\0') || path.includes('\\') || path.split('/').some((s) => s.startsWith('.'))) return { ok: false, label }
  const relative = posix.normalize(path).replace(/^\/+/, '')
  if (relative === '') return { ok: false, label }
  const full = resolve(root, relative)
  if (!full.startsWith(root + sep)) return { ok: false, label }
  return { ok: true, path: full }
}

export type Answer = 'served' | 'missing' | 'refused'

/** Answers one paused request: a file of `root`, a 404 inside it, or a refusal. */
export async function answerRequest(client: CdpClient, sessionId: string, params: CdpParams, root: string, refused: Set<string>): Promise<Answer> {
  const requestId = params.requestId as string
  const request = params.request as { url: string; method: string }
  const target = renderPath(request.url, root)
  const refuse = async (label: string): Promise<Answer> => {
    refused.add(label)
    await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined)
    return 'refused'
  }
  if (!target.ok) return refuse(target.label)
  if (request.method !== 'GET') return refuse(RENDER_ORIGIN)
  const real = await realpath(target.path).catch(() => null)
  const type = CONTENT_TYPES[extname(target.path).toLowerCase()]
  if (!real || !type) {
    await client.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }, sessionId).catch(() => undefined)
    return 'missing'
  }
  if (!real.startsWith(root + sep)) return refuse(RENDER_ORIGIN)
  const body = await readFile(real)
  await client
    .send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: body.toString('base64') }, sessionId)
    .catch(() => undefined)
  return 'served'
}

/** The page: the values in, then the brand stylesheet in <head> (as WeasyPrintEngine composes it). */
function composeSource(userSource: string, brandCss: string, values: Record<string, unknown>, fields: EngineRenderRequest['fields']): string {
  const resolved: Record<string, unknown> = Object.create(null)
  for (const f of fields) resolved[f.key] = Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : f.defaultValue
  for (const [k, v] of Object.entries(values)) resolved[k] = v
  const filled = substitute(userSource, resolved, 'html')
  const brandStyle = `<style data-brand>\n${brandCss}\n</style>`
  if (/<head\b[^>]*>/i.test(filled)) return filled.replace(/<head\b[^>]*>/i, (m) => `${m}\n${brandStyle}`)
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${brandStyle}\n</head>\n<body>\n${filled}\n</body>\n</html>`
}

export function chromiumArgs(profileDir: string): string[] {
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    `--user-data-dir=${profileDir}`,
    '--proxy-server=127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    'about:blank',
  ]
}

const fail = (message: string, file?: string): EngineRenderResult => ({ ok: false, errors: [{ severity: 'error', message, ...(file ? { file } : {}) }] })

@Injectable()
export class ChromiumEngine implements RenderEngine {
  readonly format: RenderFormat = 'html'
  readonly outputs: readonly OutputType[] = ['png', 'jpeg', 'pdf']
  timeoutMs = settings().renderTimeoutMs
  binary = settings().chromiumPath
  /** A spec swaps in a fake browser. */
  launch: (opts: LaunchOptions) => CdpClient = launchChromium

  constructor(
    private readonly brandIdentity: BrandIdentityService,
    private readonly brandAssets: BrandAssetsService,
  ) {}

  async render(req: EngineRenderRequest): Promise<EngineRenderResult> {
    if (!this.outputs.includes(req.output)) return fail(`ChromiumEngine output '${req.output}' not supported (png, jpeg, pdf)`)
    const parsed = chromiumConfigSchema.safeParse(req.engineConfig ?? {})
    if (!parsed.success) {
      return fail(`engineConfig: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'engineConfig'}: ${i.message}`).join('; ')}`, 'engineConfig')
    }
    const cfg = parsed.data
    let tagged = true
    if (req.output === 'pdf') {
      const pdf = readPdfOptions(req.engineConfig)
      if (!pdf.ok) return pdf
      if (pdf.pdf.standards.length) return fail(`engineConfig.pdf: Chromium writes no ${pdf.pdf.standards.join(', ')}; use the typst or html (WeasyPrint) format`, 'engineConfig')
      tagged = pdf.pdf.tagged
    } else {
      const { width, height, deviceScaleFactor } = cfg.viewport
      if (screenshotPixels(width, height, deviceScaleFactor) > settings().imageMaxPixels) {
        return fail(`engineConfig.viewport: more than ${settings().imageMaxPixels / 1_000_000} million pixels`, 'engineConfig')
      }
    }

    const workDir = join(tmpdir(), `fabula-chromium-${randomUUID()}`)
    const siteDir = join(workDir, 'site')
    try {
      await mkdir(siteDir, { recursive: true })
      const placed = await this.brandAssets.place(req.brand, siteDir, WEB_HTML_ASSET_FORMATS)
      if (!placed.ok) return placed
      let html: string
      try {
        html = composeSource(req.source, this.brandIdentity.buildHtml(req.brand, placed.assets), req.values, req.fields)
      } catch (err) {
        if (err instanceof TemplateValueError) return fail(err.message, 'fields')
        throw err
      }
      await writeFile(join(siteDir, 'main.html'), html, 'utf-8')
      return await this.capture(req.output, cfg, tagged, workDir, await realpath(siteDir))
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async capture(output: OutputType, cfg: ChromiumConfig, tagged: boolean, workDir: string, siteDir: string): Promise<EngineRenderResult> {
    const client = this.launch({
      binary: this.binary,
      args: chromiumArgs(join(workDir, 'profile')),
      env: engineEnv({ HOME: workDir }),
      timeoutMs: this.timeoutMs,
    })
    const refused = new Set<string>()
    try {
      const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      const page = <T = CdpParams>(method: string, params?: CdpParams) => client.send<T>(method, params, sessionId)
      const once = (event: string, match: (p: CdpParams) => boolean = () => true) =>
        new Promise<void>((done) => client.on(event, (p, sid) => sid === sessionId && match(p) && done()))
      client.on('Fetch.requestPaused', (p, sid) => {
        if (sid === sessionId) void answerRequest(client, sessionId, p, siteDir, refused).catch(() => undefined)
      })

      await page('Page.enable')
      await page('Page.setLifecycleEventsEnabled', { enabled: true })
      await page('Emulation.setScriptExecutionDisabled', { value: true })
      await page('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
      if (output !== 'pdf') {
        const { width, height, deviceScaleFactor } = cfg.viewport
        await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
      }
      const loaded = once('Page.loadEventFired')
      const idle = once('Page.lifecycleEvent', (p) => p.name === 'networkIdle')
      const nav = await page<{ errorText?: string }>('Page.navigate', { url: `${RENDER_ORIGIN}/main.html` })
      if (nav.errorText) return fail(`chromium could not open the page: ${nav.errorText}`)
      await loaded
      await Promise.race([idle, new Promise((r) => setTimeout(r, SETTLE_MS))])

      const warnings: CompileError[] = [...refused].map((label) => ({ severity: 'warning', message: `a resource outside the render was not loaded: ${label}` }))
      const done = (bytes: Buffer, mime: string): EngineRenderResult => ({ ok: true, bytes: new Uint8Array(bytes), mime, ...(warnings.length ? { warnings } : {}) })

      if (output === 'pdf') {
        const { data } = await page<{ data: string }>('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, generateTaggedPDF: tagged })
        return done(Buffer.from(data, 'base64'), 'application/pdf')
      }
      const shot: CdpParams = { format: output, captureBeyondViewport: cfg.fullPage, ...(output === 'jpeg' ? { quality: cfg.quality } : {}) }
      if (cfg.fullPage) {
        const m = await page<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>('Page.getLayoutMetrics')
        const size = m.cssContentSize ?? m.contentSize
        if (screenshotPixels(size.width, size.height, cfg.viewport.deviceScaleFactor) > settings().imageMaxPixels) {
          return fail(`the full page is more than ${settings().imageMaxPixels / 1_000_000} million pixels`, 'engineConfig')
        }
        shot.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
      }
      const { data } = await page<{ data: string }>('Page.captureScreenshot', shot)
      return done(Buffer.from(data, 'base64'), output === 'png' ? 'image/png' : 'image/jpeg')
    } catch (err) {
      if (client.timedOut) return fail(`chromium render stopped after ${this.timeoutMs / 1000} s`)
      return fail(err instanceof CdpError ? err.message : `chromium failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await client.close()
    }
  }
}
