/* AuthGuard: every request but a @Public() one comes from a known caller.

   FABULA_AUTH=hmac (the default): the request is signed (src/auth/signature.ts), inside a 60 s window; a POST, PUT,
   PATCH or DELETE signature is accepted once per process. main.ts sets rawBody: true on the Fastify adapter, so
   `req.rawBody` carries the exact bytes the caller signed.

   FABULA_AUTH=token: `Authorization: Bearer <token>`, one of FABULA_TOKENS. Simpler, but the token is the whole
   secret and travels with every request: use it only behind TLS, and prefer hmac where the caller can sign. */

import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import {
  CALLER_HEADER,
  REPLAY_METHODS,
  SIGNATURE_HEADER,
  SIGNATURE_WINDOW_SECONDS,
  parseSignatureHeader,
  requestSignature,
  SeenSignatures,
} from './signature.js'
import { CallerRegistry } from './callers.js'
import { IS_PUBLIC_KEY } from './public.decorator.js'

interface FastifyLikeRequest {
  raw?: { rawBody?: Buffer | string }
  rawBody?: Buffer | string
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  url?: string
  method?: string
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly seen = new SeenSignatures()

  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])
    if (isPublic) return true
    const req = context.switchToHttp().getRequest<FastifyLikeRequest>()
    return this.callers.mode === 'token' ? this.verifyToken(req) : this.verify(req)
  }

  private verifyToken(req: FastifyLikeRequest): boolean {
    const header = single(req.headers.authorization)
    const m = header?.match(/^Bearer ([\x21-\x7e]{1,512})$/)
    if (!m) throw new UnauthorizedException({ error: { code: 'missing_token', message: 'Authorization: Bearer <token> required' } })
    if (!this.callers.callerForToken(m[1])) throw new UnauthorizedException({ error: { code: 'invalid_token', message: 'unknown token' } })
    return true
  }

  private verify(req: FastifyLikeRequest): boolean {
    const refuse = (code: string, message: string) => new UnauthorizedException({ error: { code, message } })

    const caller = single(req.headers[CALLER_HEADER])
    const signatureHeader = single(req.headers[SIGNATURE_HEADER])
    if (!caller) throw refuse('missing_caller', `${CALLER_HEADER} required`)
    if (!signatureHeader) throw refuse('missing_signature', `${SIGNATURE_HEADER} required`)

    const secretHex = this.callers.getSecretHex(caller)
    if (!secretHex) throw refuse('unknown_caller', `caller "${caller}" not authorized`)

    const parsed = parseSignatureHeader(signatureHeader)
    if (!parsed) throw refuse('malformed_signature', 'expected t=<ts>,v1=<64 lowercase hex>')

    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parsed.t) > SIGNATURE_WINDOW_SECONDS) {
      throw refuse('stale_signature', `timestamp outside the ${SIGNATURE_WINDOW_SECONDS} s window`)
    }

    if (bodyMissing(req)) throw refuse('missing_raw_body', 'a signed write needs its raw body')

    const method = (req.method ?? '').toUpperCase()
    const expected = Buffer.from(
      requestSignature({ caller, method, pathWithQuery: req.url ?? '', rawBody: rawBodyBytes(req) }, parsed.t, secretHex),
      'hex',
    )
    if (!timingSafeEqual(expected, Buffer.from(parsed.v1, 'hex'))) {
      throw refuse('invalid_signature', 'HMAC check failed')
    }

    if (REPLAY_METHODS.has(method) && !this.seen.record(`${caller}:${parsed.v1}`, parsed.t, now)) {
      throw refuse('replayed_signature', 'this signature was already used')
    }
    return true
  }
}

function single(value: string | string[] | undefined): string | undefined {
  if (value == null) return undefined
  return Array.isArray(value) ? value[0] : value
}

/**
 * Only a GET or HEAD has no body to sign. Any other request whose raw body did not reach the guard is refused: the
 * signature would otherwise be checked over the empty string, and a signature of nothing would pass for the request.
 */
function bodyMissing(req: FastifyLikeRequest): boolean {
  const method = (req.method ?? '').toUpperCase()
  return method !== 'GET' && method !== 'HEAD' && (req.raw?.rawBody ?? req.rawBody) == null
}

/** The bytes as they arrived, which is what the signature covers. */
function rawBodyBytes(req: FastifyLikeRequest): Buffer | string {
  return req.raw?.rawBody ?? req.rawBody ?? ''
}
