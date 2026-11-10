/* The request id, on a real Fastify. */

import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { answerRequestId, genReqId, requestIdFor } from '../src/common/request-id.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('requestIdFor', () => {
  it('keeps a well-formed id and replaces anything else', () => {
    expect(requestIdFor('9b1c-1.a:b_c')).toBe('9b1c-1.a:b_c')
    expect(requestIdFor(['first', 'second'])).toBe('first')
    for (const bad of [undefined, '', 'a b', 'x'.repeat(129), 'a\nb']) expect(requestIdFor(bad)).toMatch(UUID)
  })
})

describe('a request through Fastify', () => {
  async function server() {
    const app = Fastify({ genReqId, requestIdHeader: false })
    app.addHook('onRequest', answerRequestId)
    app.get('/x', async (req) => ({ id: req.id, raw: (req.raw as { id?: string }).id }))
    return app
  }

  it('answers the id it was sent, the one the handler and the raw request see', async () => {
    const app = await server()
    const res = await app.inject({ url: '/x', headers: { 'x-request-id': 'caller-1' } })
    expect(res.headers['x-request-id']).toBe('caller-1')
    expect(res.json()).toEqual({ id: 'caller-1', raw: 'caller-1' })
  })

  it('makes one when none came, and on a route that does not exist too', async () => {
    const app = await server()
    const res = await app.inject({ url: '/x' })
    expect(res.headers['x-request-id']).toMatch(UUID)
    expect(res.json().id).toBe(res.headers['x-request-id'])
    const missing = await app.inject({ url: '/nope', headers: { 'x-request-id': 'caller-2' } })
    expect(missing.headers['x-request-id']).toBe('caller-2')
  })
})
