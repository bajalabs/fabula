/* The environment, validated at boot: a missing or malformed variable stops the service with the variable named. */

import { z } from 'zod'

const hostList = (pattern: RegExp, message: string) =>
  z
    .string()
    .default('')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(pattern, message).refine((h) => Number(h.split(':')[1] ?? 1) <= 65535, 'the port must be at most 65535')))

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(3100),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Callers and their keys, a JSON object of caller name to hex key (at least 32 hex characters). Required: there is
  // no unsigned mode. Hex only, because the verifier decodes the key as hex, and a value that is not hex would decode
  // to an empty key that anyone could sign with.
  FABULA_HMAC_KEYS: z
    .string()
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a JSON object of caller → hex secret' })
        return z.NEVER
      }
    })
    .pipe(z.record(z.string().min(1), z.string().regex(/^(?:[0-9a-fA-F]{2}){16,}$/, 'must be hex, at least 32 characters'))),

  // A render with a callback answers 202 and POSTs its result, signed as caller `fabula` with this key.
  // Without it, a callback request is refused.
  FABULA_CALLBACK_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters').optional(),
  // Where a callback may go (comma-separated): `host:port`, or `host` for the scheme's default port. Exact names, no
  // wildcard. Unset, every callback is refused.
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

  // Renders in flight at once; above it a request is answered 429. The engines are CPU-bound.
  FABULA_MAX_CONCURRENT_RENDERS: z.coerce.number().int().positive().default(6),

  // On SIGTERM, how long the renders in flight may finish before the process exits.
  SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().nonnegative().default(30),

  // With true, /readyz answers 503 while an engine binary is missing.
  ENGINE_PREFLIGHT_REQUIRED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Where Typst finds its cached packages; the image fills it at build time.
  TYPST_PACKAGE_CACHE_PATH: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${formatted}\n\nFabula refuses to start with a missing or malformed variable.`)
  }
  return parsed.data
}
