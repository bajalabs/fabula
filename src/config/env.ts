/* The environment, validated at boot: a missing or malformed variable stops the service with the variable named.
   Every variable and its default is listed in the README's configuration table and in .env.example. */

import { resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SETTINGS, ENGINE_NAMES, setSettings, type EngineName } from './settings.js'

const hostList = (pattern: RegExp, message: string) =>
  z
    .string()
    .default('')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(pattern, message).refine((h) => Number(h.split(':')[1] ?? 1) <= 65535, 'the port must be at most 65535')))

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'

const jsonMap = (value: z.ZodString, what: string) =>
  z
    .string()
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: `must be a JSON object of caller → ${what}` })
        return z.NEVER
      }
    })
    .pipe(z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'a caller name is letters, digits, . _ or -'), value))

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true')

const positive = (fallback: number, max: number) => z.coerce.number().int().positive().max(max).default(fallback)

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    PORT: z.coerce.number().int().positive().max(65535).default(3100),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    // How callers prove who they are: `hmac` (a signed request, the default) or `token` (a bearer token).
    FABULA_AUTH: z.enum(['hmac', 'token']).default('hmac'),
    // hmac: callers and their keys, a JSON object of caller name to hex key (at least 32 hex characters). Hex only,
    // because the verifier decodes the key as hex, and a value that is not hex would decode to an empty key that
    // anyone could sign with.
    FABULA_HMAC_KEYS: jsonMap(z.string().regex(/^(?:[0-9a-fA-F]{2}){16,}$/, 'must be hex, at least 32 characters'), 'hex secret').optional(),
    // token: callers and their tokens, a JSON object of caller name to token (at least 32 printable characters).
    FABULA_TOKENS: jsonMap(z.string().regex(/^[\x21-\x7e]{32,512}$/, 'must be 32 to 512 printable characters, no space'), 'token').optional(),

    // A render with a callback answers 202 and POSTs its result, signed as caller `fabula` with this key.
    // Without it, a callback request is refused.
    FABULA_CALLBACK_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters').optional(),
    // Where a callback may go (comma-separated): `host:port`, or `host` for the scheme's default port. Exact names,
    // no wildcard. Unset, every callback is refused.
    FABULA_CALLBACK_HOSTS: hostList(
      new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::[1-9][0-9]{0,4})?$`),
      'must be a host name or host:port, without a scheme, path or wildcard',
    ),

    // The hosts brand files and document pictures may be fetched from (comma-separated): an exact name, or
    // `*.example.com` for any name under example.com (not example.com itself), with `:port` when it is not 443.
    // Unset, nothing is fetched: a request with files fails, naming this variable.
    FABULA_ASSET_HOSTS: hostList(
      new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*(?::[1-9][0-9]{0,4})?$`),
      'must be a host name or *.host, with :port if not 443, without a scheme or path',
    ),

    // Limits
    FABULA_BODY_LIMIT_BYTES: positive(8 * 1024 * 1024, 256 * 1024 * 1024),
    FABULA_MAX_CONCURRENT_RENDERS: positive(6, 1024),
    FABULA_RENDER_TIMEOUT_SECONDS: positive(DEFAULT_SETTINGS.renderTimeoutMs / 1000, 3600),
    FABULA_ASSET_MAX_BYTES: positive(DEFAULT_SETTINGS.assetMaxBytes, 1024 * 1024 * 1024),
    FABULA_ASSET_TIMEOUT_SECONDS: positive(DEFAULT_SETTINGS.assetTimeoutMs / 1000, 600),
    FABULA_IMAGE_MAX_PIXELS: positive(DEFAULT_SETTINGS.imageMaxPixels, 1_000_000_000),

    // Storage
    FABULA_ASSET_CACHE_DIR: z.string().min(1).default(DEFAULT_SETTINGS.assetCacheDir),
    FABULA_ASSET_CACHE_MAX_BYTES: positive(DEFAULT_SETTINGS.assetCacheMaxBytes, 1024 * 1024 * 1024 * 1024),
    FABULA_TEMPLATES_DIR: z.string().min(1).default(DEFAULT_SETTINGS.templatesDir),

    // What runs
    FABULA_ENGINES: z
      .string()
      .default(ENGINE_NAMES.join(','))
      .transform((v) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
      .pipe(z.array(z.enum(ENGINE_NAMES)).min(1, 'name at least one engine')),
    FABULA_ALLOW_INLINE_SOURCE: flag(true),
    FABULA_CHROMIUM_PATH: z.string().min(1).default(DEFAULT_SETTINGS.chromiumPath),
    // With true, /readyz answers 503 while an enabled engine's binary is missing.
    FABULA_REQUIRE_ENGINES: flag(true),

    // On SIGTERM, how long the renders in flight may finish before the process exits.
    FABULA_DRAIN_SECONDS: z.coerce.number().int().nonnegative().max(3600).default(30),

    // Where Typst finds its cached packages; the image fills it at build time.
    TYPST_PACKAGE_CACHE_PATH: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.FABULA_AUTH === 'hmac' && !env.FABULA_HMAC_KEYS) {
      ctx.addIssue({ code: 'custom', path: ['FABULA_HMAC_KEYS'], message: 'required with FABULA_AUTH=hmac (the default)' })
    }
    if (env.FABULA_AUTH === 'token' && !env.FABULA_TOKENS) {
      ctx.addIssue({ code: 'custom', path: ['FABULA_TOKENS'], message: 'required with FABULA_AUTH=token' })
    }
  })

export type Env = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): Env {
  // An empty variable is an unset one: compose and .env files pass optional variables through as ''
  const parsed = envSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '')))
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${formatted}\n\nFabula refuses to start with a missing or malformed variable.`)
  }
  const env = parsed.data
  setSettings({
    renderTimeoutMs: env.FABULA_RENDER_TIMEOUT_SECONDS * 1000,
    assetMaxBytes: env.FABULA_ASSET_MAX_BYTES,
    assetTimeoutMs: env.FABULA_ASSET_TIMEOUT_SECONDS * 1000,
    assetCacheDir: resolve(env.FABULA_ASSET_CACHE_DIR),
    assetCacheMaxBytes: env.FABULA_ASSET_CACHE_MAX_BYTES,
    imageMaxPixels: env.FABULA_IMAGE_MAX_PIXELS,
    templatesDir: resolve(env.FABULA_TEMPLATES_DIR),
    allowInlineSource: env.FABULA_ALLOW_INLINE_SOURCE,
    engines: new Set<EngineName>(env.FABULA_ENGINES),
    chromiumPath: env.FABULA_CHROMIUM_PATH,
  })
  return env
}
