/* envSchema: FABULA_HMAC_KEYS must be hex. The verifier decodes each key as hex; a value that is not hex would decode
   to an empty key that anyone could sign with. */

import { describe, expect, it } from 'vitest'
import { envSchema } from '../src/config/env.js'

const parse = (keys: unknown) => envSchema.safeParse({ FABULA_HMAC_KEYS: JSON.stringify(keys) })

describe('envSchema FABULA_HMAC_KEYS', () => {
  it('accepts a map of callers to hex secrets', () => {
    const r = parse({ 'billing-api': 'ab'.repeat(32), reports: '0123456789abcdef0123456789ABCDEF' })
    expect(r.success).toBe(true)
  })

  it('refuses a secret that is not hex, whatever its length', () => {
    expect(parse({ ci: 'ci-only-not-a-secret-0000000000000000' }).success).toBe(false)
  })

  it('refuses an odd count of hex characters and a short secret', () => {
    expect(parse({ ci: 'a'.repeat(33) }).success).toBe(false)
    expect(parse({ ci: 'ab'.repeat(15) }).success).toBe(false)
  })

  it('refuses a value that is not JSON', () => {
    expect(envSchema.safeParse({ FABULA_HMAC_KEYS: '{not json' }).success).toBe(false)
  })
})

describe('envSchema without the deployment-specific values', () => {
  const base = { FABULA_HMAC_KEYS: '{"billing-api":"' + 'ab'.repeat(32) + '"}' }

  it('boots with no callback host and no asset host, and names none by default', () => {
    const parsed = envSchema.parse(base)
    expect(parsed.PORT).toBe(3100)
    expect(parsed.FABULA_CALLBACK_HOSTS).toEqual([])
    expect(parsed.FABULA_ASSET_HOSTS).toEqual([])
  })

  it('reads FABULA_ASSET_HOSTS as lower-case names, exact or *.host', () => {
    const parsed = envSchema.parse({ ...base, FABULA_ASSET_HOSTS: ' Abc.Files.example.com, *.cdn.example.com ,' })
    expect(parsed.FABULA_ASSET_HOSTS).toEqual(['abc.files.example.com', '*.cdn.example.com'])
  })

  it('reads FABULA_CALLBACK_HOSTS as lower-case host or host:port', () => {
    const parsed = envSchema.parse({ ...base, FABULA_CALLBACK_HOSTS: ' Jobs-Worker:3036, api.example.com ,' })
    expect(parsed.FABULA_CALLBACK_HOSTS).toEqual(['jobs-worker:3036', 'api.example.com'])
  })

  it('refuses a callback entry with a wildcard, a scheme, a path or a port out of range', () => {
    for (const bad of ['*', '*.example.com', 'http://a.example.com', 'a.example.com/x', 'a.example.com:0', 'a.example.com:70000', 'a.example.com:']) {
      expect(envSchema.safeParse({ ...base, FABULA_CALLBACK_HOSTS: bad }).success, bad).toBe(false)
    }
  })

  it('reads a FABULA_ASSET_HOSTS entry with its port', () => {
    const parsed = envSchema.parse({ ...base, FABULA_ASSET_HOSTS: 'a.example.com:8443,*.example.com:443' })
    expect(parsed.FABULA_ASSET_HOSTS).toEqual(['a.example.com:8443', '*.example.com:443'])
  })

  it('refuses an entry that is not a host: a bare *, a scheme, a bad port, a path', () => {
    for (const bad of ['*', '*.', 'https://a.example.com', 'a.example.com:0', 'a.example.com:', 'a.example.com/x', 'a.*.example.com']) {
      expect(envSchema.safeParse({ ...base, FABULA_ASSET_HOSTS: bad }).success, bad).toBe(false)
    }
  })
})
