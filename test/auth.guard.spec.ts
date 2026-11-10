/* AuthGuard: valid; a missing half or a malformed header; an unknown caller; another key; the method, path, query or
   body changed; stale; a replay refused; a read repeated; @Public() bypassing; and a fixed signature vector. */

import { describe, expect, it } from 'vitest'
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { Buffer } from 'node:buffer'
import {
  CALLER_HEADER,
  parseSignatureHeader,
  requestSignature,
  SeenSignatures,
  SIGNATURE_HEADER,
  signRequest,
} from '../src/auth/signature.js'
import { AuthGuard } from '../src/auth/auth.guard.js'
import type { CallerRegistry } from '../src/auth/callers.js'

const ALLOWED_CALLER = 'reports'

const SECRET_HEX = 'a'.repeat(64) // 32 bytes hex
const WRONG_SECRET_HEX = 'b'.repeat(64)

function makeRegistry(secretHex = SECRET_HEX): CallerRegistry {
  return {
    getSecretHex: (caller: string) =>
      caller === ALLOWED_CALLER ? secretHex : null,
    hasCaller: (caller: string) => caller === ALLOWED_CALLER,
  } as unknown as CallerRegistry
}

function makeReflector(isPublic = false): Reflector {
  return {
    getAllAndOverride: () => isPublic,
  } as unknown as Reflector
}

function signedContext(
  headers: Record<string, string>,
  target: { method?: string; url?: string; body?: string } = {},
): ExecutionContext {
  const body = target.body ?? ''
  const req = {
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody: body === '' ? undefined : Buffer.from(body, 'utf8'),
    method: target.method ?? 'POST',
    url: target.url ?? '/render?dry=1',
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext
}

function signedHeaders(
  over: { method?: string; pathWithQuery?: string; rawBody?: string; caller?: string; t?: number; key?: string } = {},
): Record<string, string> {
  return signRequest(
    {
      caller: over.caller ?? ALLOWED_CALLER,
      method: over.method ?? 'POST',
      pathWithQuery: over.pathWithQuery ?? '/render?dry=1',
      rawBody: over.rawBody ?? '{"x":1}',
    },
    over.key ?? SECRET_HEX,
    over.t,
  )
}

function refusal(guard: AuthGuard, ctx: ExecutionContext): string {
  try {
    guard.canActivate(ctx)
  } catch (err) {
    expect(err).toBeInstanceOf(UnauthorizedException)
    return ((err as UnauthorizedException).getResponse() as { error: { code: string } }).error.code
  }
  return 'passed'
}

describe('AuthGuard', () => {
  const guard = () => new AuthGuard(makeReflector(), makeRegistry())
  const target = { url: '/render?dry=1', body: '{"x":1}' }

  it('passes a valid signature over method, path with query and body', () => {
    expect(guard().canActivate(signedContext(signedHeaders(), target))).toBe(true)
  })

  it('passes a read signed with an empty body', () => {
    const headers = signedHeaders({ method: 'GET', pathWithQuery: '/templates', rawBody: '' })
    expect(guard().canActivate(signedContext(headers, { method: 'GET', url: '/templates' }))).toBe(true)
  })

  it('refuses a changed path, query, method or body', () => {
    const headers = signedHeaders()
    expect(refusal(guard(), signedContext(headers, { ...target, url: '/preview?dry=1' }))).toBe('invalid_signature')
    expect(refusal(guard(), signedContext(headers, { ...target, url: '/render?dry=2' }))).toBe('invalid_signature')
    expect(refusal(guard(), signedContext(headers, { ...target, url: '/render' }))).toBe('invalid_signature')
    expect(refusal(guard(), signedContext(headers, { ...target, method: 'PUT' }))).toBe('invalid_signature')
    expect(refusal(guard(), signedContext(headers, { ...target, body: '{"x":2}' }))).toBe('invalid_signature')
  })

  it('refuses a signature made with another key or for another caller', () => {
    expect(refusal(guard(), signedContext(signedHeaders({ key: WRONG_SECRET_HEX }), target))).toBe('invalid_signature')
    expect(refusal(guard(), signedContext(signedHeaders({ caller: 'someone-else' }), target))).toBe('unknown_caller')
  })

  it('refuses a stale signature on either side of the 60 s window, and takes one inside it', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(refusal(guard(), signedContext(signedHeaders({ t: now - 3600 }), target))).toBe('stale_signature')
    expect(refusal(guard(), signedContext(signedHeaders({ t: now + 3600 }), target))).toBe('stale_signature')
    expect(guard().canActivate(signedContext(signedHeaders({ t: now - 30 }), target))).toBe(true)
  })

  it('accepts a write once: the same signature again is a replay', () => {
    const g = guard()
    const headers = signedHeaders()
    expect(g.canActivate(signedContext(headers, target))).toBe(true)
    expect(refusal(g, signedContext(headers, target))).toBe('replayed_signature')
  })

  it('refuses two byte-identical writes in the same second, and takes two that differ by meta.requestId', () => {
    // Same caller, time, target and bytes make the same signature, so the second looks exactly like a replay. That
    // is the rule, not an accident: a caller gives each render its own meta.requestId, and the bytes differ.
    const g = guard()
    const t = Math.floor(Date.now() / 1000)
    const render = (requestId: string) => JSON.stringify({ template: 'checklist@1', meta: { requestId } })
    const send = (body: string) => signedContext(signedHeaders({ rawBody: body, t }), { ...target, body })
    expect(g.canActivate(send(render('a')))).toBe(true)
    expect(refusal(g, send(render('a')))).toBe('replayed_signature')
    expect(g.canActivate(send(render('b')))).toBe(true)
  })

  it('refuses a write whose raw body never reached the guard, even one signed over nothing', () => {
    const headers = signedHeaders({ rawBody: '' })
    expect(refusal(guard(), signedContext(headers, { url: '/render?dry=1' }))).toBe('missing_raw_body')
  })

  it('does not spend a signature on a refused request', () => {
    const g = guard()
    const headers = signedHeaders()
    expect(refusal(g, signedContext(headers, { ...target, body: 'tampered' }))).toBe('invalid_signature')
    expect(g.canActivate(signedContext(headers, target))).toBe(true)
  })

  it('lets a read be repeated', () => {
    const g = guard()
    const headers = signedHeaders({ method: 'GET', pathWithQuery: '/templates', rawBody: '' })
    const read = { method: 'GET', url: '/templates' }
    expect(g.canActivate(signedContext(headers, read))).toBe(true)
    expect(g.canActivate(signedContext(headers, read))).toBe(true)
  })

  it('refuses a missing half and a malformed header', () => {
    const headers = signedHeaders()
    expect(refusal(guard(), signedContext({ [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER] }, target))).toBe('missing_caller')
    expect(refusal(guard(), signedContext({ [CALLER_HEADER]: ALLOWED_CALLER }, target))).toBe('missing_signature')
    for (const bad of ['gibberish', 't=1', `t=1,v1=${'A'.repeat(64)}`, `t=1,t=2,v1=${'a'.repeat(64)}`, `t=1,v1=${'a'.repeat(64)},x=1`]) {
      expect(refusal(guard(), signedContext({ [CALLER_HEADER]: ALLOWED_CALLER, [SIGNATURE_HEADER]: bad }, target)), bad).toBe('malformed_signature')
    }
  })

  it('bypasses HMAC for @Public() handlers', () => {
    expect(new AuthGuard(makeReflector(true), makeRegistry()).canActivate(signedContext({}))).toBe(true)
  })

  it('refuses a request with no signature', () => {
    expect(refusal(guard(), signedContext({}, target))).toBe('missing_caller')
  })
})

describe('requestSignature', () => {
  const key = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'

  it('gives the fixed vector the README documents', () => {
    expect(
      requestSignature({ caller: 'reports', method: 'GET', pathWithQuery: '/templates', rawBody: '' }, 1793491200, key),
    ).toBe('11d457d465ebabd0dfd1655580043f4a4e48a7669cc9006c3b806a045c983215')
    expect(
      requestSignature({ caller: 'reports', method: 'post', pathWithQuery: '/render?dry=1', rawBody: '{"template":"checklist@1"}' }, 1793491200, key),
    ).toBe('6ea1f4cb5eab93921cefc3bc33bae619fc2ec530d0c207c572afb0c98a649cb4')
  })

  it('reads the same over a string and over its bytes', () => {
    const request = { caller: 'c', method: 'POST', pathWithQuery: '/render', rawBody: 'año' }
    expect(requestSignature({ ...request, rawBody: Buffer.from('año', 'utf8') }, 1, key)).toBe(requestSignature(request, 1, key))
  })
})

describe('parseSignatureHeader', () => {
  it('takes t and v1 in either order', () => {
    const v1 = 'a'.repeat(64)
    expect(parseSignatureHeader(`v1=${v1},t=12`)).toEqual({ t: 12, v1 })
  })
})

describe('SeenSignatures', () => {
  it('lets a key go once its window has passed', () => {
    const seen = new SeenSignatures(60)
    expect(seen.record('k', 100, 100)).toBe(true)
    expect(seen.record('k', 100, 160)).toBe(false)
    expect(seen.record('k', 100, 161)).toBe(true)
    expect(seen.size).toBe(1)
  })
})
