/* BrandAssetsService: brings a brand's font and logo files, and a document's pictures, into a render's work
   directory.

   Each file arrives as an https URL plus the sha256 of its bytes. Per file:
     • https only, and only from a host on FABULA_ASSET_HOSTS (an exact name, or `*.example.com` for the names under
       it, with `:port` when it is not 443; unset, nothing is fetched), so a signed caller cannot point Fabula
       anywhere else.
     • `redirect: 'error'`, a 15 s timeout, at most 10 MB (the body is read in chunks and abandoned past the cap).
     • The sha256 of the bytes must equal the declared one, else the render fails with a compile-style error that
       names the asset (kind, role or variant) and the host, never the path or the query string, which may carry a
       signature.
     • Content-addressed cache under os.tmpdir()/fabula-assets/<sha256>.<ext>, re-hashed on every hit, written
       atomically, so a second render of the same brand does not refetch.
     • Linked (or copied) into <workDir>/_shared/fonts/ and <workDir>/_shared/logos/, which the engine's rm -rf
       removes with the rest of the work directory; the cache stays.

   Logos land under stable names (<variant>-<mode>.<ext>) so a template can also point at them by hand; fonts under
   their hash, since engines find a font by its family, not its file name.

   A document's pictures (cards in one-pager@1 and checklist@1) come the same way and under the same rules, into
   _shared/images/, named by hash with the extension their bytes prove: PNG, JPEG or WebP, nothing else, and at most
   40 million pixels by their header.

   The cache holds at most 512 MB: past that, the files used longest ago go first. */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '../../config/env.js'
import { imageExtension, imageSize } from '../../util/image-file.js'
import type {
  BrandFont,
  BrandFontFormat,
  BrandIdentity,
  BrandLogo,
  BrandLogoFormat,
  CompileError,
} from '../../contracts/index.js'

export const BRAND_ASSET_MAX_BYTES = 10 * 1024 * 1024
export const BRAND_ASSET_TIMEOUT_MS = 15_000
export const BRAND_ASSET_CACHE_MAX_BYTES = 512 * 1024 * 1024
export const DOCUMENT_IMAGE_MAX_PIXELS = 40_000_000

/** Work-directory folders, relative to the work directory (posix). */
export const BRAND_FONT_DIR = '_shared/fonts'
export const BRAND_LOGO_DIR = '_shared/logos'
export const DOCUMENT_IMAGE_DIR = '_shared/images'

export interface PlacedFont {
  font: BrandFont
  /** Posix path relative to the work directory. */
  path: string
}

export interface PlacedLogo {
  logo: BrandLogo
  /** Posix path relative to the work directory. */
  path: string
}

export interface BrandAssets {
  fonts: PlacedFont[]
  logos: PlacedLogo[]
  /** Absolute font directory when at least one font was placed. */
  fontDir: string | null
}

/** Which formats an engine can use, in order of preference. One file
 *  is placed per font face (family, weight, style) and per logo
 *  (variant, mode): the first format in the list that the record has. */
export interface BrandAssetFormats {
  fonts: readonly BrandFontFormat[]
  logos: readonly BrandLogoFormat[]
}

/** Typst (and Pandoc / Quarto PDF through it) reads TrueType and
 *  OpenType only; a PDF logo needs Typst 0.14 or later, so it comes last. */
export const TYPST_ASSET_FORMATS: BrandAssetFormats = {
  fonts: ['ttf', 'otf'],
  logos: ['svg', 'png', 'pdf'],
}

/** WeasyPrint: raw sfnt first (no decompression step), then WOFF2 and
 *  WOFF; it cannot draw a PDF as an image. */
export const PRINT_HTML_ASSET_FORMATS: BrandAssetFormats = {
  fonts: ['ttf', 'otf', 'woff2', 'woff'],
  logos: ['svg', 'png'],
}

/** A browser page (Quarto's HTML): WOFF2 first. */
export const WEB_HTML_ASSET_FORMATS: BrandAssetFormats = {
  fonts: ['woff2', 'woff', 'ttf', 'otf'],
  logos: ['svg', 'png'],
}

export type BrandAssetsResult =
  | { ok: true; assets: BrandAssets }
  | { ok: false; errors: CompileError[] }

/** A picture a document asks for; `where` names it in an error (never its URL). */
export interface ImageRequest {
  url: string
  sha256: string
  where: string
}

export type DocumentImagesResult =
  | { ok: true; paths: string[] }
  | { ok: false; errors: CompileError[] }

export const NO_BRAND_ASSETS: BrandAssets = { fonts: [], logos: [], fontDir: null }

interface AssetSpec {
  url: string
  sha256: string
  ext: string
  label: string
}

export class BrandAssetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrandAssetError'
  }
}

export function fontLabel(f: BrandFont): string {
  return `brand font (role ${f.role}, ${f.family} ${f.weight} ${f.style}, ${f.format})`
}

export function logoLabel(l: BrandLogo): string {
  return `brand logo (variant ${l.variant}, mode ${l.mode}, ${l.format})`
}

/** First item per key, choosing the format that comes earliest in
 *  `prefs`; formats outside `prefs` are dropped. Keeps record order. */
function pickPerKey<T extends { format: string }>(
  items: readonly T[],
  key: (item: T) => string,
  prefs: readonly string[],
): T[] {
  const best = new Map<string, T>()
  for (const item of items) {
    const rank = prefs.indexOf(item.format)
    if (rank < 0) continue
    const k = key(item)
    const held = best.get(k)
    if (!held || rank < prefs.indexOf(held.format)) best.set(k, item)
  }
  return Array.from(best.values())
}

/** The message of a fetch failure, with the URL scrubbed out in case
 *  the runtime put it there. */
function describeFetchError(err: unknown, url: URL): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `timed out after ${BRAND_ASSET_TIMEOUT_MS / 1000} s`
  }
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
  const parts = [err instanceof Error ? err.message : String(err)]
  if (cause instanceof Error) parts.push(cause.message)
  let msg = parts.filter(Boolean).join(': ')
  for (const leak of [url.href, url.search, url.pathname]) {
    if (leak && leak !== '/') msg = msg.split(leak).join('')
  }
  return msg.slice(0, 300)
}

/** `hosts` as FABULA_ASSET_HOSTS gives them: lower case, exact or `*.example.com`, with `:port` when it is not 443.
 *  `port` is a URL's: '' means 443. */
export function assetHostAllowed(hostname: string, hosts: readonly string[], port = ''): boolean {
  const host = hostname.toLowerCase()
  return hosts.some((entry) => {
    const [allowed = '', listed = '443'] = entry.split(':')
    const name = allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1 : host === allowed
    return name && listed === (port || '443')
  })
}

@Injectable()
export class BrandAssetsService {
  /** Content-addressed cache; tests point it at a scratch folder. */
  cacheDir = join(tmpdir(), 'fabula-assets')
  cacheMaxBytes = BRAND_ASSET_CACHE_MAX_BYTES

  private readonly inflight = new Map<string, Promise<string>>()
  private readonly hosts: readonly string[]

  constructor(config: ConfigService<Env, true>) {
    this.hosts = config.get('FABULA_ASSET_HOSTS', { infer: true })
    if (this.hosts.length === 0) {
      new Logger('BrandAssets').warn('FABULA_ASSET_HOSTS is not set: a brand with fonts or logos cannot render')
    }
  }

  /**
   * Fetch (or reuse) every font and logo the engine can use and place
   * them in `workDir`. A brand without fonts and logos costs nothing.
   * Every failing asset is reported, not only the first.
   */
  async place(
    brand: BrandIdentity,
    workDir: string,
    formats: BrandAssetFormats,
  ): Promise<BrandAssetsResult> {
    const fonts = pickPerKey(
      brand.fonts ?? [],
      (f) => `${f.family.toLowerCase()}|${f.weight}|${f.style}`,
      formats.fonts,
    )
    const logos = pickPerKey(
      brand.logos ?? [],
      (l) => `${l.variant}|${l.mode}`,
      formats.logos,
    )
    if (fonts.length === 0 && logos.length === 0) {
      return { ok: true, assets: NO_BRAND_ASSETS }
    }

    if (fonts.length) await mkdir(join(workDir, BRAND_FONT_DIR), { recursive: true })
    if (logos.length) await mkdir(join(workDir, BRAND_LOGO_DIR), { recursive: true })

    const jobs: Array<Promise<PlacedFont | PlacedLogo>> = [
      ...fonts.map(async (font): Promise<PlacedFont> => {
        const path = `${BRAND_FONT_DIR}/${font.sha256}.${font.format}`
        const cached = await this.fetchToCache({
          url: font.url,
          sha256: font.sha256,
          ext: font.format,
          label: fontLabel(font),
        })
        await this.linkInto(cached, join(workDir, path))
        return { font, path }
      }),
      ...logos.map(async (logo): Promise<PlacedLogo> => {
        const path = `${BRAND_LOGO_DIR}/${logo.variant}-${logo.mode}.${logo.format}`
        const cached = await this.fetchToCache({
          url: logo.url,
          sha256: logo.sha256,
          ext: logo.format,
          label: logoLabel(logo),
        })
        await this.linkInto(cached, join(workDir, path))
        return { logo, path }
      }),
    ]

    const settled = await Promise.allSettled(jobs)
    const errors: CompileError[] = []
    const assets: BrandAssets = { fonts: [], logos: [], fontDir: null }
    for (const s of settled) {
      if (s.status === 'rejected') {
        if (s.reason instanceof BrandAssetError) {
          errors.push({ severity: 'error', message: s.reason.message, file: 'brand' })
          continue
        }
        throw s.reason
      }
      if ('font' in s.value) assets.fonts.push(s.value)
      else assets.logos.push(s.value)
    }
    if (errors.length) return { ok: false, errors }
    if (assets.fonts.length) assets.fontDir = join(workDir, BRAND_FONT_DIR)
    return { ok: true, assets }
  }

  /**
   * Fetch (or reuse) a document's pictures and place them in `workDir`. Answers one path per request, in order,
   * root-anchored for Typst. Every failing picture is reported, not only the first.
   */
  async placeImages(images: readonly ImageRequest[], workDir: string): Promise<DocumentImagesResult> {
    if (images.length === 0) return { ok: true, paths: [] }
    await mkdir(join(workDir, DOCUMENT_IMAGE_DIR), { recursive: true })
    const settled = await Promise.allSettled(
      images.map(async (image): Promise<string> => {
        const label = `image (${image.where})`
        const cached = await this.fetchToCache({ url: image.url, sha256: image.sha256, ext: 'img', label })
        const bytes = await readFile(cached)
        const ext = imageExtension(bytes)
        if (!ext) throw new BrandAssetError(`${label}: the file is not a PNG, JPEG or WebP`)
        const size = imageSize(bytes, ext)
        if (!size || size.width < 1 || size.height < 1) throw new BrandAssetError(`${label}: the file's size cannot be read`)
        if (size.width * size.height > DOCUMENT_IMAGE_MAX_PIXELS) {
          throw new BrandAssetError(`${label}: ${size.width}×${size.height} is more than ${DOCUMENT_IMAGE_MAX_PIXELS / 1_000_000} million pixels`)
        }
        const path = `${DOCUMENT_IMAGE_DIR}/${image.sha256}.${ext}`
        await this.linkInto(cached, join(workDir, path))
        return `/${path}`
      }),
    )
    const errors: CompileError[] = []
    const paths: string[] = []
    for (const s of settled) {
      if (s.status === 'fulfilled') paths.push(s.value)
      else if (s.reason instanceof BrandAssetError) errors.push({ severity: 'error', message: s.reason.message, file: 'fields' })
      else throw s.reason
    }
    return errors.length ? { ok: false, errors } : { ok: true, paths }
  }

  /** Path of the verified file in the cache, fetching it when absent.
   *  Concurrent renders asking for the same file share one fetch. */
  async fetchToCache(spec: AssetSpec): Promise<string> {
    const key = `${spec.sha256}.${spec.ext}`
    const pending = this.inflight.get(key)
    if (pending) return pending
    const job = this.resolve(spec).finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  private async resolve(spec: AssetSpec): Promise<string> {
    const target = join(this.cacheDir, `${spec.sha256}.${spec.ext}`)
    const hit = await readFile(target).catch(() => null)
    if (hit && sha256(hit) === spec.sha256) {
      const now = new Date()
      await utimes(target, now, now).catch(() => {}) // used just now: eviction goes by this time
      return target
    }
    if (hit) await rm(target, { force: true })

    const bytes = await this.download(spec)
    const actual = sha256(bytes)
    if (actual !== spec.sha256) {
      throw new BrandAssetError(
        `${spec.label}: sha256 mismatch (declared ${spec.sha256}, received ${actual})`,
      )
    }
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
    const part = `${target}.${randomUUID()}.part`
    await writeFile(part, bytes, { mode: 0o600 })
    await rename(part, target)
    await this.evict(target)
    return target
  }

  /** Past the cache's limit, the files used longest ago go. `keep`, just written, stays. */
  private async evict(keep: string): Promise<void> {
    const names = (await readdir(this.cacheDir)).filter((n) => !n.endsWith('.part'))
    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(this.cacheDir, name)
        const s = await stat(path).catch(() => null)
        return { path, size: s?.size ?? 0, used: s?.mtimeMs ?? 0 }
      }),
    )
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const file of files.sort((a, b) => a.used - b.used)) {
      if (total <= this.cacheMaxBytes) return
      if (file.path === keep) continue
      await rm(file.path, { force: true })
      total -= file.size
    }
  }

  private async download(spec: AssetSpec): Promise<Buffer> {
    let url: URL
    try {
      url = new URL(spec.url)
    } catch {
      throw new BrandAssetError(`${spec.label}: the url is not a valid URL`)
    }
    if (url.protocol !== 'https:') {
      throw new BrandAssetError(`${spec.label}: only https URLs are fetched`)
    }
    if (!assetHostAllowed(url.hostname, this.hosts, url.port)) {
      throw new BrandAssetError(`${spec.label}: host ${url.host} is not on FABULA_ASSET_HOSTS`)
    }
    const from = `from ${url.host}`

    let res: Response
    try {
      res = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(BRAND_ASSET_TIMEOUT_MS),
      })
    } catch (err) {
      throw new BrandAssetError(`${spec.label}: fetch ${from} failed (${describeFetchError(err, url)})`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new BrandAssetError(`${spec.label}: fetch ${from} answered ${res.status}`)
    }

    const tooLarge = () =>
      new BrandAssetError(`${spec.label}: file ${from} is larger than ${BRAND_ASSET_MAX_BYTES / (1024 * 1024)} MB`)
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) > BRAND_ASSET_MAX_BYTES) {
      await res.body?.cancel().catch(() => {})
      throw tooLarge()
    }

    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > BRAND_ASSET_MAX_BYTES) {
            await reader.cancel().catch(() => {})
            throw tooLarge()
          }
          chunks.push(value)
        }
      } catch (err) {
        if (err instanceof BrandAssetError) throw err
        throw new BrandAssetError(`${spec.label}: reading ${from} failed (${describeFetchError(err, url)})`)
      }
    }
    return Buffer.concat(chunks)
  }

  /** Hard link from the cache (same filesystem under os.tmpdir()),
   *  a copy when linking is refused; a repeat of the same file is fine. */
  private async linkInto(cached: string, dest: string): Promise<void> {
    try {
      await link(cached, dest)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return
      await copyFile(cached, dest)
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
