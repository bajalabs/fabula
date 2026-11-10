/* The request id: a well-formed `x-request-id` from the caller is kept, so the caller can join its logs with these;
   anything else gets a fresh uuid. It is answered on every response and carried by every log line. It is not
   signed: it only joins logs, and it decides nothing. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const REQUEST_ID_HEADER = 'x-request-id'
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function requestIdFor(inbound: string | string[] | undefined): string {
  const value = Array.isArray(inbound) ? inbound[0] : inbound
  return value && SAFE_ID.test(value) ? value : randomUUID()
}

/** Fastify's genReqId. The id is also put on the raw request, where pino-http and nestjs-cls read it. */
export function genReqId(req: Pick<IncomingMessage, 'headers'>): string {
  const id = requestIdFor(req.headers[REQUEST_ID_HEADER])
  ;(req as { id?: string }).id = id
  return id
}

/** Fastify's onRequest hook: every answer carries the id, a refusal or a 404 too. */
export function answerRequestId(
  req: { id: string },
  reply: { header(name: string, value: string): unknown },
  done: () => void,
): void {
  reply.header(REQUEST_ID_HEADER, req.id)
  done()
}
