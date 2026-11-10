/* The HTTP surface end to end, through the real application on Fastify's inject: the health routes are public; a
   signed render answers 200, an unsigned or replayed one 401; a value that does not fit is a 400; a render that
   fails is a 422; the request id comes back. MJML runs in process, so this needs no engine binary. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { signRequest } from '../src/auth/signature.js'

const KEY = 'c1'.repeat(32)
const ENV = {
  FABULA_HMAC_KEYS: JSON.stringify({ ci: KEY }),
  FABULA_REQUIRE_ENGINES: 'false',
  FABULA_ENGINES: 'mjml,typst',
  LOG_LEVEL: 'error',
  NODE_ENV: 'test',
}

describe('the HTTP surface', () => {
  let app: NestFastifyApplication
  const saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    const { validateEnv } = await import('../src/config/env.js')
    const { createApp } = await import('../src/app.js')
    app = await createApp(validateEnv(process.env))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app?.close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const { resetSettings } = await import('../src/config/settings.js')
    resetSettings()
  })

  const send = (method: 'GET' | 'POST', url: string, body?: unknown, sign = true, headers: Record<string, string> = {}) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const signed = sign ? signRequest({ caller: 'ci', method, pathWithQuery: url, rawBody: payload }, KEY) : {}
    return app.inject({ method, url, payload: payload || undefined, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...signed, ...headers } })
  }

  it('answers the health routes without a signature', async () => {
    const health = await send('GET', '/health', undefined, false)
    expect(health.statusCode).toBe(200)
    expect(Object.keys(health.json().engines).sort()).toEqual(['mjml', 'typst'])
    expect((await send('GET', '/healthz', undefined, false)).statusCode).toBe(200)
  })

  it('renders a named template, signed, with 200 and the request id', async () => {
    const r = await send('POST', '/render', { template: 'announcement@1', values: { heading: 'Hello', body: 'World' }, meta: { requestId: 'a' } }, true, { 'x-request-id': 'req-1' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['x-request-id']).toBe('req-1')
    const out = r.json()
    expect(out.ok).toBe(true)
    expect(out.mime).toBe('text/html; charset=utf-8')
    expect(Buffer.from(out.bytes, 'base64').toString('utf-8')).toContain('Hello')
  })

  it('refuses an unsigned render and a replayed one with 401', async () => {
    expect((await send('POST', '/render', { template: 'announcement@1', values: { heading: 'x', body: 'y' } }, false)).statusCode).toBe(401)
    const body = JSON.stringify({ template: 'announcement@1', values: { heading: 'x', body: 'y' }, meta: { requestId: 'replay' } })
    const headers = { 'content-type': 'application/json', ...signRequest({ caller: 'ci', method: 'POST', pathWithQuery: '/render', rawBody: body }, KEY) }
    expect((await app.inject({ method: 'POST', url: '/render', payload: body, headers })).statusCode).toBe(200)
    const again = await app.inject({ method: 'POST', url: '/render', payload: body, headers })
    expect(again.statusCode).toBe(401)
    expect(again.json().error.code).toBe('replayed_signature')
  })

  it('answers 400 naming the field when a value does not fit its type', async () => {
    const r = await send('POST', '/render', { template: 'announcement@1', values: { heading: { a: 1 }, body: 'y' } })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: ['heading'] }] })
    const inline = await send('POST', '/render', { format: 'mjml', source: '<mjml></mjml>', fields: [{ key: 'title', label: 'T', fieldTypeKey: 'string' }], values: { title: 7 } })
    expect(inline.statusCode).toBe(400)
  })

  it('answers 422 for a render that fails, with its errors', async () => {
    const r = await send('POST', '/render', { format: 'quarto', source: '# x' })
    expect(r.statusCode).toBe(422)
    expect(r.json().errors[0].message).toContain('No engine registered for format="quarto"')
  })

  it('lists the templates, signed', async () => {
    const r = await send('GET', '/templates')
    expect(r.statusCode).toBe(200)
    expect(r.json().templates.map((t: { id: string }) => t.id)).toContain('announcement@1')
  })

  it('answers 400 for data that does not parse', async () => {
    const r = await send('POST', '/data/parse', { sourceFormat: 'json', content: '{nope' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('parse_failed')
  })
})
