/* BrandAssetsService: fetch, verify, cache and place the brand's font and logo files, and a document's pictures.

   Covered: a verified file lands in the work directory under _shared/; a sha256 mismatch is an error naming the asset,
   never the URL's path or query string; a non-https URL is refused before any fetch; an oversized body (declared, or
   streamed past 10 MB) is refused; a second render is served from the content-addressed cache; fetch is called with
   redirect: 'error' and a timeout signal; only the formats an engine can use are fetched, one per face; a document's
   pictures go through the same rules and must be a PNG, JPEG or WebP by their bytes.

   globalThis.fetch is a vitest spy; the cache points at a scratch folder per test. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  brandIdentitySchema,
  type BrandIdentity,
} from '../src/contracts/index.js'
import {
  BRAND_ASSET_MAX_BYTES,
  assetHostAllowed,
  BrandAssetsService,
  NO_BRAND_ASSETS,
  PRINT_HTML_ASSET_FORMATS,
  TYPST_ASSET_FORMATS,
} from '../src/render/brand/brand-assets.service.js'
import { imageExtension, imageSize } from '../src/util/image-file.js'

const FONT_BYTES = Buffer.from('fake ttf bytes')
const LOGO_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const FONT_URL = 'https://files.example.com/brand/fonts/inter-700.ttf?X-Amz-Signature=sekret'
const LOGO_URL = 'https://files.example.com/brand/logos/primary.svg?X-Amz-Signature=sekret'

function brandWith(extra: Record<string, unknown>): BrandIdentity {
  return brandIdentitySchema.parse({
    brandName: 'Acme',
    displayName: 'Acme',
    primaryColor: '#111111',
    secondaryColor: '#222222',
    fontBody: 'Noto Sans',
    fontHeading: 'Inter',
    ...extra,
  })
}

const FONT = {
  role: 'heading',
  family: 'Inter',
  weight: 700,
  style: 'normal',
  format: 'ttf',
  url: FONT_URL,
  sha256: sha(FONT_BYTES),
}
const LOGO = {
  variant: 'primary',
  mode: 'light',
  format: 'svg',
  url: LOGO_URL,
  sha256: sha(LOGO_BYTES),
}

/** A Response whose body arrives in `chunks`, with no content-length. */
function streamed(chunks: Uint8Array[]): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const config = (hosts: string[]) => ({ get: () => hosts }) as never

describe('assetHostAllowed', () => {
  it('takes an exact name, in any case, and nothing around it', () => {
    expect(assetHostAllowed('files.example.com', ['files.example.com'])).toBe(true)
    expect(assetHostAllowed('Files.Example.COM', ['files.example.com'])).toBe(true)
    expect(assetHostAllowed('x.files.example.com', ['files.example.com'])).toBe(false)
    expect(assetHostAllowed('files.example.com.evil.test', ['files.example.com'])).toBe(false)
    expect(assetHostAllowed('files.example.com.', ['files.example.com'])).toBe(false)
  })

  it('takes *.example.com for the names under it, at any depth, never the name itself', () => {
    const hosts = ['*.example.com']
    expect(assetHostAllowed('a.example.com', hosts)).toBe(true)
    expect(assetHostAllowed('a.b.example.com', hosts)).toBe(true)
    expect(assetHostAllowed('example.com', hosts)).toBe(false)
    expect(assetHostAllowed('badexample.com', hosts)).toBe(false)
    expect(assetHostAllowed('.example.com', hosts)).toBe(false)
  })

  it('refuses everything with an empty list', () => {
    expect(assetHostAllowed('files.example.com', [])).toBe(false)
  })

  it('takes 443 only, unless the entry names a port, and then only that one', () => {
    expect(assetHostAllowed('files.example.com', ['files.example.com'], '8443')).toBe(false)
    expect(assetHostAllowed('files.example.com', ['files.example.com:443'])).toBe(true)
    expect(assetHostAllowed('files.example.com', ['files.example.com:8443'], '8443')).toBe(true)
    expect(assetHostAllowed('files.example.com', ['files.example.com:8443'])).toBe(false)
    expect(assetHostAllowed('files.example.com', ['files.example.com:8443'], '9443')).toBe(false)
    expect(assetHostAllowed('a.example.com', ['*.example.com'], '8443')).toBe(false)
    expect(assetHostAllowed('a.example.com', ['*.example.com:8443'], '8443')).toBe(true)
  })
})

describe('BrandAssetsService', () => {
  let svc: BrandAssetsService
  let scratch: string
  let workDir: string
  let fetchSpy: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-assets-spec-'))
    workDir = join(scratch, 'work')
    svc = new BrandAssetsService(config(['files.example.com']))
    svc.cacheDir = join(scratch, 'cache')
    fetchSpy = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url === FONT_URL) return new Response(FONT_BYTES, { status: 200 })
      if (url === LOGO_URL) return new Response(LOGO_BYTES, { status: 200 })
      return new Response('nope', { status: 404 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(scratch, { recursive: true, force: true })
  })

  it('fetches nothing from a host not on FABULA_ASSET_HOSTS, and names the host, never the path or query', async () => {
    const result = await svc.place(
      brandWith({ logos: [{ ...LOGO, url: 'https://metadata.internal/latest/keys?sig=sekret' }] }),
      workDir,
      TYPST_ASSET_FORMATS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].message).toMatch(/host metadata\.internal is not on FABULA_ASSET_HOSTS/)
    expect(result.errors[0].message).not.toMatch(/latest|sekret/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with FABULA_ASSET_HOSTS unset, a brand with files fails and one without still renders', async () => {
    const open = new BrandAssetsService(config([]))
    open.cacheDir = join(scratch, 'cache-unset')
    const refused = await open.place(brandWith({ fonts: [FONT] }), workDir, TYPST_ASSET_FORMATS)
    expect(refused.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    const plain = await open.place(brandWith({}), workDir, TYPST_ASSET_FORMATS)
    expect(plain).toEqual({ ok: true, assets: NO_BRAND_ASSETS })
  })

  it('follows a wildcard entry', async () => {
    const wild = new BrandAssetsService(config(['*.example.com']))
    wild.cacheDir = join(scratch, 'cache-wild')
    expect((await wild.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)).ok).toBe(true)
  })

  it('costs nothing for a brand without fonts and logos', async () => {
    const res = await svc.place(brandWith({}), workDir, TYPST_ASSET_FORMATS)
    expect(res).toEqual({ ok: true, assets: { fonts: [], logos: [], fontDir: null } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('places verified files in the work directory', async () => {
    const res = await svc.place(brandWith({ fonts: [FONT], logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { fonts, logos, fontDir } = res.assets
    expect(fonts.map((f) => f.path)).toEqual([`_shared/fonts/${FONT.sha256}.ttf`])
    expect(logos.map((l) => l.path)).toEqual(['_shared/logos/primary-light.svg'])
    expect(fontDir).toBe(join(workDir, '_shared/fonts'))
    expect(await readFile(join(workDir, fonts[0].path))).toEqual(FONT_BYTES)
    expect(await readFile(join(workDir, logos[0].path))).toEqual(LOGO_BYTES)
  })

  it('fetches with redirect: error and a timeout signal', async () => {
    await svc.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [input, init] = fetchSpy.mock.calls[0] as [URL, RequestInit]
    expect(String(input)).toBe(LOGO_URL)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails the render on a sha256 mismatch, naming the asset but not the URL', async () => {
    const wrong = { ...FONT, sha256: 'f'.repeat(64) }
    const res = await svc.place(brandWith({ fonts: [wrong] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors).toHaveLength(1)
    const msg = res.errors[0].message
    expect(res.errors[0].severity).toBe('error')
    expect(msg).toMatch(/^brand font \(role heading, Inter 700 normal, ttf\): sha256 mismatch/)
    expect(msg).toContain(`received ${FONT.sha256}`)
    expect(msg).not.toContain('X-Amz-Signature')
    expect(msg).not.toContain('sekret')
    expect(msg).not.toContain('/brand/fonts/')
    // Nothing cached under the declared hash
    expect(await readdir(svc.cacheDir).catch(() => [])).toEqual([])
  })

  it('reports every failing asset, not only the first', async () => {
    const res = await svc.place(
      brandWith({
        fonts: [{ ...FONT, sha256: 'f'.repeat(64) }],
        logos: [{ ...LOGO, url: 'https://files.example.com/missing.svg?sig=1' }],
      }),
      workDir,
      TYPST_ASSET_FORMATS,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.map((e) => e.message.split(':')[0])).toEqual([
      'brand font (role heading, Inter 700 normal, ttf)',
      'brand logo (variant primary, mode light, svg)',
    ])
    expect(res.errors[1].message).toContain('from files.example.com answered 404')
    expect(res.errors[1].message).not.toContain('sig=1')
  })

  it('refuses a non-https URL without fetching', async () => {
    // The schema already refuses it; the service holds the line on its own
    const logo = { ...brandWith({ logos: [LOGO] }).logos![0], url: 'http://files.example.com/logo.svg' }
    const res = await svc.place({ ...brandWith({}), logos: [logo] }, workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0].message).toBe('brand logo (variant primary, mode light, svg): only https URLs are fetched')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a body that grows past 10 MB without a content-length', async () => {
    const mb = new Uint8Array(1024 * 1024)
    fetchSpy.mockImplementationOnce(async () => streamed(Array.from({ length: 11 }, () => mb)))
    const res = await svc.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0].message).toBe(
      'brand logo (variant primary, mode light, svg): file from files.example.com is larger than 10 MB',
    )
  })

  it('refuses a declared content-length over the cap before reading', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(LOGO_BYTES, {
          status: 200,
          headers: { 'content-length': String(BRAND_ASSET_MAX_BYTES + 1) },
        }),
    )
    const res = await svc.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0].message).toMatch(/larger than 10 MB$/)
  })

  it('names a timeout without the URL', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      throw new DOMException(`The operation was aborted due to timeout (${LOGO_URL})`, 'TimeoutError')
    })
    const res = await svc.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0].message).toBe(
      'brand logo (variant primary, mode light, svg): fetch from files.example.com failed (timed out after 15 s)',
    )
  })

  it('scrubs the URL out of a network error message', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect at ${LOGO_URL}`) })
    })
    const res = await svc.place(brandWith({ logos: [LOGO] }), workDir, TYPST_ASSET_FORMATS)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0].message).toContain('fetch failed: unexpected redirect at')
    expect(res.errors[0].message).not.toContain('sekret')
    expect(res.errors[0].message).not.toContain('/brand/logos/')
  })

  it('serves the second render from the cache', async () => {
    const b = brandWith({ fonts: [FONT], logos: [LOGO] })
    const first = await svc.place(b, workDir, TYPST_ASSET_FORMATS)
    expect(first.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const second = await svc.place(b, join(scratch, 'work-2'), TYPST_ASSET_FORMATS)
    expect(second.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // no refetch
    expect((await readdir(svc.cacheDir)).sort()).toEqual(
      [`${FONT.sha256}.ttf`, `${LOGO.sha256}.svg`].sort(),
    )
    expect(await readFile(join(scratch, 'work-2', '_shared/logos/primary-light.svg'))).toEqual(LOGO_BYTES)
  })

  it('refetches when the cached file no longer matches its hash', async () => {
    const b = brandWith({ logos: [LOGO] })
    await svc.place(b, workDir, TYPST_ASSET_FORMATS)
    await writeFile(join(svc.cacheDir, `${LOGO.sha256}.svg`), 'tampered')
    const again = await svc.place(b, join(scratch, 'work-2'), TYPST_ASSET_FORMATS)
    expect(again.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(await readFile(join(svc.cacheDir, `${LOGO.sha256}.svg`))).toEqual(LOGO_BYTES)
  })

  it('fetches one file per face in the engine’s preferred format only', async () => {
    const woff2 = { ...FONT, format: 'woff2', url: 'https://files.example.com/inter.woff2', sha256: 'e'.repeat(64) }
    const pdfLogo = { ...LOGO, format: 'pdf', url: 'https://files.example.com/logo.pdf', sha256: 'd'.repeat(64) }
    const b = brandWith({ fonts: [woff2, FONT], logos: [pdfLogo, LOGO] })

    // Typst: ttf over woff2 (which it cannot read), svg over pdf
    const typst = await svc.place(b, workDir, TYPST_ASSET_FORMATS)
    expect(typst.ok).toBe(true)
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).sort()).toEqual([FONT_URL, LOGO_URL].sort())

    // WeasyPrint: never a PDF logo
    fetchSpy.mockClear()
    const html = await svc.place(
      brandWith({ logos: [pdfLogo] }),
      join(scratch, 'work-2'),
      PRINT_HTML_ASSET_FORMATS,
    )
    expect(html).toEqual({ ok: true, assets: { fonts: [], logos: [], fontDir: null } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shares one fetch between concurrent renders of the same file', async () => {
    const b = brandWith({ logos: [LOGO] })
    const [a, c] = await Promise.all([
      svc.place(b, workDir, TYPST_ASSET_FORMATS),
      svc.place(b, join(scratch, 'work-2'), TYPST_ASSET_FORMATS),
    ])
    expect(a.ok && c.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('BrandAssetsService.placeImages', () => {
  /** A PNG's signature and its size; the size is all the service reads. */
  const pngOf = (width: number, height: number) => {
    const size = Buffer.alloc(8)
    size.writeUInt32BE(width)
    size.writeUInt32BE(height, 4)
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), size, Buffer.from('rest')])
  }
  const PNG = pngOf(1200, 1500)
  const IMAGE_URL = 'https://files.example.com/media/pail.png?X-Amz-Signature=sekret'
  const image = (over: Record<string, string> = {}) => ({ url: IMAGE_URL, sha256: sha(PNG), where: 'sections.0.items.1', ...over })
  const originalFetch = globalThis.fetch
  let svc: BrandAssetsService
  let scratch: string
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-images-spec-'))
    svc = new BrandAssetsService(config(['files.example.com']))
    svc.cacheDir = join(scratch, 'cache')
    fetchSpy = vi.fn(async () => new Response(PNG, { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(scratch, { recursive: true, force: true })
  })

  it('knows the three kinds by their bytes, and nothing else', () => {
    expect(imageExtension(PNG)).toBe('png')
    expect(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpg')
    expect(imageExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(imageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageExtension(Buffer.alloc(0))).toBeNull()
  })

  it('places a picture under its hash, with no redirects and a timeout, and fetches it once', async () => {
    const r = await svc.placeImages([image()], scratch)
    expect(r).toEqual({ ok: true, paths: [`/_shared/images/${sha(PNG)}.png`] })
    expect(await readFile(join(scratch, '_shared/images', `${sha(PNG)}.png`))).toEqual(PNG)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    await svc.placeImages([image()], scratch)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('costs nothing with no pictures', async () => {
    expect(await svc.placeImages([], scratch)).toEqual({ ok: true, paths: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(readdir(join(scratch, '_shared'))).rejects.toThrow()
  })

  it('refuses a wrong hash, naming the value and never the URL', async () => {
    const r = await svc.placeImages([image({ sha256: 'a'.repeat(64) })], scratch)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ file: 'fields' })
    expect(r.errors[0].message).toContain('image (sections.0.items.1): sha256 mismatch')
    expect(JSON.stringify(r.errors)).not.toContain('sekret')
    expect(JSON.stringify(r.errors)).not.toContain('pail.png')
  })

  it('refuses a host not on FABULA_ASSET_HOSTS, and anything but https, before any fetch', async () => {
    const other = await svc.placeImages([image({ url: 'https://evil.example/pail.png' })], scratch)
    expect(!other.ok && other.errors[0].message).toContain('host evil.example is not on FABULA_ASSET_HOSTS')
    const port = await svc.placeImages([image({ url: 'https://files.example.com:8443/pail.png' })], scratch)
    expect(!port.ok && port.errors[0].message).toContain('host files.example.com:8443 is not on FABULA_ASSET_HOSTS')
    const plain = await svc.placeImages([image({ url: 'http://files.example.com/pail.png' })], scratch)
    expect(!plain.ok && plain.errors[0].message).toContain('only https')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a body past the size limit', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200, headers: { 'content-length': String(BRAND_ASSET_MAX_BYTES + 1) } }))
    const r = await svc.placeImages([image()], scratch)
    expect(!r.ok && r.errors[0].message).toContain('larger than 10 MB')
  })

  it('refuses a file that is not a picture, even with the right hash', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    fetchSpy.mockResolvedValue(new Response(svg, { status: 200 }))
    const r = await svc.placeImages([image({ sha256: sha(svg) })], scratch)
    expect(!r.ok && r.errors[0].message).toContain('not a PNG, JPEG or WebP')
  })

  it('reads the size each kind declares', () => {
    expect(imageSize(PNG, 'png')).toEqual({ width: 1200, height: 1500 })
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+VtU/wCQnd/9dpP/AEI1Qq/qn/ITu/8ArtJ/6EaoV9wfoh//2Q==', 'base64')
    expect(imageSize(jpeg, 'jpg')).toEqual({ width: 2, height: 2 })
    const lossy = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
    const lossless = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64')
    expect(imageSize(lossy, 'webp')).toEqual({ width: 1, height: 1 })
    expect(imageSize(lossless, 'webp')).toEqual({ width: 1, height: 1 })
    expect(imageSize(Buffer.from('RIFF\0\0\0\0WEBP'), 'webp')).toBeNull()
  })

  it('refuses a small file that declares too many pixels, and one whose size cannot be read', async () => {
    const huge = pngOf(20_000, 20_000)
    fetchSpy.mockResolvedValue(new Response(huge, { status: 200 }))
    const r = await svc.placeImages([image({ sha256: sha(huge) })], scratch)
    expect(!r.ok && r.errors[0].message).toContain('more than 40 million pixels')
    const cut = PNG.subarray(0, 12)
    fetchSpy.mockResolvedValue(new Response(cut, { status: 200 }))
    const c = await svc.placeImages([image({ sha256: sha(cut) })], scratch)
    expect(!c.ok && c.errors[0].message).toContain('size cannot be read')
  })

  it('keeps the cache under its limit, the file used longest ago going first', async () => {
    svc.cacheMaxBytes = PNG.length * 2 + 1
    const files = [pngOf(1, 1), pngOf(2, 2), pngOf(3, 3)]
    const place = async (b: Buffer) => {
      fetchSpy.mockResolvedValue(new Response(b, { status: 200 }))
      return svc.placeImages([image({ sha256: sha(b) })], scratch)
    }
    await place(files[0])
    await new Promise((r) => setTimeout(r, 20))
    await place(files[1])
    await new Promise((r) => setTimeout(r, 20))
    await place(files[0]) // a hit: it is now the newer of the two
    await new Promise((r) => setTimeout(r, 20))
    await place(files[2])
    const left = await readdir(svc.cacheDir)
    expect(left.sort()).toEqual([`${sha(files[0])}.img`, `${sha(files[2])}.img`].sort())
  })

  it('reports every failing picture, not only the first', async () => {
    const r = await svc.placeImages([image({ sha256: 'a'.repeat(64) }), image({ sha256: 'b'.repeat(64), where: 'sections.2.items.0' })], scratch)
    expect(!r.ok && r.errors).toHaveLength(2)
  })
})

/* Logos, before: a logo's bytes were never looked at, so a PNG logo of 60000 × 60000 (a 1-bit file under 1 MB) went
   to the engine unmeasured, and an "SVG" could be anything. Now a logo's bytes must be the format it claims, and a
   PNG logo is held to the same pixel bound as a picture. */
describe('BrandAssetsService, a logo’s bytes', () => {
  let renders = 0
  let svc: BrandAssetsService
  let scratch: string
  const originalFetch = globalThis.fetch
  const pngHeader = (width: number, height: number) => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0)
    b.write('IHDR', 12, 'latin1')
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    b[24] = 1 // one bit a pixel
    return b
  }
  const placeLogo = async (format: 'png' | 'svg' | 'pdf', bytes: Buffer) => {
    globalThis.fetch = vi.fn(async () => new Response(bytes, { status: 200 })) as unknown as typeof globalThis.fetch
    const logo = { variant: 'primary', mode: 'light', format, url: `https://files.example.com/logo.${format}`, sha256: sha(bytes) }
    return svc.place(brandWith({ logos: [logo] }), join(scratch, `work-${++renders}`), TYPST_ASSET_FORMATS)
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fabula-logo-spec-'))
    svc = new BrandAssetsService(config(['files.example.com']))
    svc.cacheDir = join(scratch, 'cache')
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(scratch, { recursive: true, force: true })
  })

  it('measures a PNG logo against the pixel bound', async () => {
    const r = await placeLogo('png', pngHeader(60_000, 60_000))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0]).toMatchObject({ file: 'brand' })
    expect(!r.ok && r.errors[0].message).toContain('brand logo (variant primary, mode light, png): 60000×60000 is more than 40 million pixels')
    expect((await placeLogo('png', pngHeader(600, 200))).ok).toBe(true)
  })

  it('refuses a logo whose bytes are not its format', async () => {
    expect(await placeLogo('png', Buffer.from('<svg/>'))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('not a PNG') }] })
    expect(await placeLogo('pdf', Buffer.from('<svg/>'))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('not a PDF') }] })
    expect(await placeLogo('svg', pngHeader(2, 2))).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('not an SVG') }] })
    expect((await placeLogo('pdf', Buffer.from('%PDF-1.7\n%%EOF'))).ok).toBe(true)
  })

  it('refuses an SVG logo with a DOCTYPE or an entity', async () => {
    const bomb = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa">]><svg xmlns="http://www.w3.org/2000/svg"><text>&a;</text></svg>')
    expect(await placeLogo('svg', bomb)).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('DOCTYPE or an entity') }] })
  })
})
