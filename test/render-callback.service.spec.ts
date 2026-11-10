/* RenderCallbackService: a long render calls back, signed as `fabula`, only to the hosts it may, retrying what can
   succeed later and stopping on a refusal. */

import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { callbackHostAllowed, RenderCallbackService, signCallback } from '../src/render/render-callback.service.js'

const KEY = 'ab'.repeat(32)
const config = (over: Record<string, unknown> = {}) =>
  ({ get: (k: string) => ({ FABULA_CALLBACK_KEY: KEY, FABULA_CALLBACK_HOSTS: ['jobs-worker:3036', '127.0.0.1:9', 'api.example.com'], ...over })[k] }) as never

function service(statuses: Array<number | 'throw'>, over: Record<string, unknown> = {}) {
  const s = new RenderCallbackService(config(over))
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  s.sleep = async () => {}
  s.fetch = async (url, init) => {
    calls.push({ url, headers: init!.headers as Record<string, string>, body: String(init!.body) })
    const next = statuses.shift() ?? 200
    if (next === 'throw') throw new TypeError('fetch failed')
    return new Response(next === 204 ? null : '', { status: next }) // a 204 carries no body
  }
  return { s, calls }
}

describe('signCallback', () => {
  it("signs caller.t.POST.path?query.body with the hex-decoded key", () => {
    const url = new URL('http://jobs-worker:3036/hooks/fabula?x=1')
    const h = signCallback(url, '{"a":1}', KEY, 1_800_000_000)
    const expected = createHmac('sha256', Buffer.from(KEY, 'hex')).update('fabula.1800000000.POST./hooks/fabula?x=1.{"a":1}').digest('hex')
    expect(h).toEqual({ 'content-type': 'application/json', 'x-fabula-caller': 'fabula', 'x-fabula-signature': `t=1800000000,v1=${expected}` })
  })
})

describe('the boot', () => {
  it('warns once when the list is empty, and not otherwise', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    new RenderCallbackService(config({ FABULA_CALLBACK_HOSTS: [] }))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/FABULA_CALLBACK_HOSTS/)
    warn.mockClear()
    new RenderCallbackService(config())
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('refusal', () => {
  it('refuses without a key, a non-URL, a non-http scheme and a host not on the list', () => {
    expect(new RenderCallbackService(config({ FABULA_CALLBACK_KEY: undefined })).refusal('http://127.0.0.1/x')?.message).toMatch(/FABULA_CALLBACK_KEY/)
    const s = new RenderCallbackService(config())
    expect(s.refusal('not a url')?.file).toBe('callback')
    expect(s.refusal('ftp://127.0.0.1/x')?.message).toMatch(/http/)
    expect(s.refusal('https://evil.example/x')?.message).toMatch(/evil.example/)
    expect(s.refusal('http://jobs-worker:3036/cb')).toBeNull()
  })

  it('takes only the listed port of a listed host', () => {
    const s = new RenderCallbackService(config())
    expect(s.refusal('http://jobs-worker:5432/cb')?.message).toMatch(/jobs-worker:5432/)
    expect(s.refusal('http://jobs-worker/cb')?.file).toBe('callback')
    expect(s.refusal('http://JOBS-WORKER:3036/cb')).toBeNull()
  })

  it("reads an entry without a port as the scheme's default port only", () => {
    const hosts = ['api.example.com']
    expect(callbackHostAllowed(new URL('https://api.example.com/cb'), hosts)).toBe(true)
    expect(callbackHostAllowed(new URL('http://api.example.com/cb'), hosts)).toBe(true)
    expect(callbackHostAllowed(new URL('https://api.example.com:443/cb'), hosts)).toBe(true)
    expect(callbackHostAllowed(new URL('https://api.example.com:8443/cb'), hosts)).toBe(false)
    expect(callbackHostAllowed(new URL('http://api.example.com:443/cb'), hosts)).toBe(false)
  })

  it('takes an entry with the default port for a URL that leaves it out', () => {
    expect(callbackHostAllowed(new URL('https://a.example.com/cb'), ['a.example.com:443'])).toBe(true)
    expect(callbackHostAllowed(new URL('http://a.example.com/cb'), ['a.example.com:443'])).toBe(false)
  })
})

describe('deliver', () => {
  const event = { jobId: 'j1', event: 'render.completed' as const, result: { ok: true as const, mime: 'application/pdf', bytes: 'JVBERg==', durationMs: 5 } }

  it('delivers once on a 2xx, signed', async () => {
    const { s, calls } = service([204])
    expect(await s.deliver('http://127.0.0.1:9/cb', event)).toEqual({ delivered: true, status: 204 })
    expect(calls).toHaveLength(1)
    expect(calls[0].headers['x-fabula-caller']).toBe('fabula')
    expect(JSON.parse(calls[0].body)).toMatchObject({ jobId: 'j1', event: 'render.completed' })
  })

  it('asks fetch not to follow a redirect, stops on a 3xx and does not count it as delivered', async () => {
    const seen: RequestInit[] = []
    const { s, calls } = service([302])
    const send = s.fetch
    s.fetch = (url, init) => { seen.push(init!); return send(url, init) }
    expect(await s.deliver('http://127.0.0.1:9/cb', event)).toEqual({ delivered: false, status: 302 })
    expect(calls).toHaveLength(1)
    expect(seen[0].redirect).toBe('manual')
  })

  it('retries a 5xx and a network failure, then succeeds', async () => {
    const { s, calls } = service([503, 'throw', 200])
    expect(await s.deliver('http://127.0.0.1:9/cb', event)).toEqual({ delivered: true, status: 200 })
    expect(calls).toHaveLength(3)
  })

  it('stops on a refusal (401) and gives up after three attempts', async () => {
    const a = service([401])
    expect(await a.s.deliver('http://127.0.0.1:9/cb', event)).toEqual({ delivered: false, status: 401 })
    expect(a.calls).toHaveLength(1)
    const b = service([500, 500, 500])
    expect((await b.s.deliver('http://127.0.0.1:9/cb', event)).delivered).toBe(false)
    expect(b.calls).toHaveLength(3)
  })
})

describe('runAndDeliver', () => {
  it('delivers render.failed when the render throws, naming capacity for a 429', async () => {
    const { s, calls } = service([200])
    const busy = Object.assign(new Error('busy'), { getStatus: () => 429 })
    await s.runAndDeliver('http://127.0.0.1:9/cb', 'j2', async () => { throw busy })
    const sent = JSON.parse(calls[0].body)
    expect(sent).toMatchObject({ jobId: 'j2', event: 'render.failed', result: { ok: false } })
    expect(sent.result.errors[0].message).toMatch(/capacity/)
  })
})
