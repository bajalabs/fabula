/* The runtime settings the engines and services read: limits, timeouts, where files go, which engines run. They come
   from the environment once validateEnv (src/config/env.ts) has checked it, at boot; until then, and in the specs,
   they are the defaults below, which are also the documented defaults of each variable. */

import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ENGINE_NAMES = ['typst', 'pandoc', 'quarto', 'weasyprint', 'mjml', 'chromium'] as const
export type EngineName = (typeof ENGINE_NAMES)[number]

export interface Settings {
  /** FABULA_RENDER_TIMEOUT_SECONDS: one engine process (and the page previews) at most this long. */
  renderTimeoutMs: number
  /** FABULA_ASSET_MAX_BYTES: one brand file or picture at most this large. */
  assetMaxBytes: number
  /** FABULA_ASSET_TIMEOUT_SECONDS: one brand file or picture fetched in at most this long. */
  assetTimeoutMs: number
  /** FABULA_ASSET_CACHE_DIR: the content-addressed cache of brand files and pictures. */
  assetCacheDir: string
  /** FABULA_ASSET_CACHE_MAX_BYTES: past this, the files used longest ago leave the cache. */
  assetCacheMaxBytes: number
  /** FABULA_IMAGE_MAX_PIXELS: a picture or raster logo at most this many pixels, by its header. */
  imageMaxPixels: number
  /** FABULA_TEMPLATES_DIR: the named templates, read once at boot. */
  templatesDir: string
  /** FABULA_ALLOW_INLINE_SOURCE: whether a request may carry its own source instead of a template's name. */
  allowInlineSource: boolean
  /** FABULA_ENGINES: the engines this instance runs. */
  engines: ReadonlySet<EngineName>
  /** FABULA_CHROMIUM_PATH: the Chromium binary. */
  chromiumPath: string
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  renderTimeoutMs: 60_000,
  assetMaxBytes: 10 * 1024 * 1024,
  assetTimeoutMs: 15_000,
  assetCacheDir: join(tmpdir(), 'fabula-assets'),
  assetCacheMaxBytes: 512 * 1024 * 1024,
  imageMaxPixels: 40_000_000,
  templatesDir: resolve(process.cwd(), 'templates'),
  allowInlineSource: true,
  engines: new Set(ENGINE_NAMES),
  chromiumPath: 'chromium',
})

let current: Settings = { ...DEFAULT_SETTINGS }

export const settings = (): Readonly<Settings> => current

/** Set once at boot by validateEnv; a spec may set a part and restore the defaults with resetSettings(). */
export function setSettings(next: Partial<Settings>): void {
  current = { ...current, ...next }
}

export function resetSettings(): void {
  current = { ...DEFAULT_SETTINGS }
}
