/* The asset cache and a concurrent eviction (regression).

   Before: a render was handed a cache path, and only then linked the file into its work directory. An eviction by
   another render in between removed the file, the link and the copy both failed, and the render threw an error that
   carried the cache's temp path. Now the link is made first and the bytes are read from the work directory; a cache
   entry that is gone is fetched again, and an unexpected file-system error is answered without its path. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { BrandAssetsService, TYPST_ASSET_FORMATS } from '../src/render/brand/brand-assets.service.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, link: vi.fn(actual.link), copyFile: vi.fn(actual.copyFile) }
})

const FONT = Buffer.from('fake ttf bytes')
const sha = createHash('sha256').update(FONT).digest('hex')
const brand = brandIdentitySchema.parse({
  fonts: [{ role: 'body', family: 'Inter', format: 'ttf', url: 'https://files.example.com/inter.ttf', sha256: sha }],
})

describe('a cache entry evicted between the cache and the work directory', () => {
  const originalFetch = globalThis.fetch
  let scratch: string
  let svc: BrandAssetsService
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    scratch = await fs.mkdtemp(join(tmpdir(), 'fabula-cache-spec-'))
    svc = new BrandAssetsService({ get: () => ['files.example.com'] } as never)
    svc.cacheDir = join(scratch, 'cache')
    fetchSpy = vi.fn(async () => new Response(FONT, { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    vi.mocked(fs.link).mockClear()
    vi.mocked(fs.copyFile).mockClear()
    await fs.rm(scratch, { recursive: true, force: true })
  })

  it('is fetched again, and the render gets its file', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    // Another render's eviction removes the entry just before this render links it
    vi.mocked(fs.link).mockImplementationOnce(async (src, dst) => {
      await actual.rm(src, { force: true })
      return actual.link(src, dst)
    })
    const workDir = join(scratch, 'work')
    const r = await svc.place(brand, workDir, TYPST_ASSET_FORMATS)
    expect(r.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(await fs.readFile(join(workDir, `_shared/fonts/${sha}.ttf`))).toEqual(FONT)
  })

  it('answers an unexpected file-system error without a server path', async () => {
    const denied = (path: unknown) => Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: 'EACCES' })
    vi.mocked(fs.link).mockImplementationOnce(async (src) => {
      throw denied(src)
    })
    vi.mocked(fs.copyFile).mockImplementationOnce(async (src) => {
      throw denied(src)
    })
    const r = await svc.place(brand, join(scratch, 'work'), TYPST_ASSET_FORMATS)
    expect(r.ok).toBe(false)
    const message = !r.ok ? r.errors[0].message : ''
    expect(message).toBe('a brand file or picture could not be placed; try again')
    expect(message).not.toContain(tmpdir())
  })
})
