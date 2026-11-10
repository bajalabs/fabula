/* The request signature. Pure functions; the guard holds the one SeenSignatures.

     x-fabula-caller:    <caller>      a key of FABULA_HMAC_KEYS
     x-fabula-signature: t=<unix seconds>,v1=<hex>
     message:            `${caller}.${t}.${METHOD}.${pathWithQuery}.${rawBody}`
                         (rawBody '' when there is none)
     algorithm:          HMAC-SHA256 with the caller's key decoded from hex, lowercase hex digest,
                         constant-time comparison
     freshness:          |now − t| ≤ 60 s
     replay:             a POST, PUT, PATCH or DELETE signature is accepted once per process

   Callbacks from Fabula are signed the same way, as caller `fabula`. */

import { createHmac } from 'node:crypto'

export const CALLER_HEADER = 'x-fabula-caller'
export const SIGNATURE_HEADER = 'x-fabula-signature'
export const SIGNATURE_WINDOW_SECONDS = 60

export interface SignatureParts {
  t: number
  v1: string
}

export interface SignedRequest {
  caller: string
  method: string
  /** The request target exactly as sent: the path, plus `?query` when there is one. */
  pathWithQuery: string
  /** The exact body; '' when there is none. */
  rawBody: string | Buffer
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** The body goes in as bytes, so a signature never depends on decoding them. */
export function requestSignature(request: SignedRequest, t: number, hexKey: string): string {
  const prefix = `${request.caller}.${t}.${request.method.toUpperCase()}.${request.pathWithQuery}.`
  return createHmac('sha256', Buffer.from(hexKey, 'hex')).update(prefix, 'utf8').update(request.rawBody).digest('hex')
}

/** The headers a caller sends (scripts/sign.mjs does the same from the command line). */
export function signRequest(request: SignedRequest, hexKey: string, t: number = nowSeconds()): Record<string, string> {
  return {
    [CALLER_HEADER]: request.caller,
    [SIGNATURE_HEADER]: `t=${t},v1=${requestSignature(request, t, hexKey)}`,
  }
}

/** `t=<unix s>,v1=<64 lowercase hex>`, in either order; a repeated, extra or missing part is refused. */
export function parseSignatureHeader(header: string): SignatureParts | null {
  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const index = piece.indexOf('=')
    if (index <= 0) return null
    const key = piece.slice(0, index).trim()
    if (parts.has(key)) return null
    parts.set(key, piece.slice(index + 1).trim())
  }
  const t = parts.get('t')
  const v1 = parts.get('v1')
  if (parts.size !== 2 || !t || !/^[0-9]{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return null
  return { t: Number(t), v1 }
}

/** The methods whose signature is kept once seen: a replayed write could render or call back twice. */
export const REPLAY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The replay guard: a signature is accepted once per process; the same key again inside the window is refused. Each
 * entry leaves once its window has passed, pruned at most once a second unless the set grows large. Run one replica,
 * or put a sticky load balancer in front, if replays across replicas matter to you.
 */
export class SeenSignatures {
  private readonly seen = new Map<string, number>()
  private lastPrune = -1

  constructor(private readonly windowSeconds: number = SIGNATURE_WINDOW_SECONDS) {}

  /** True when the key is new (kept until t + window); false when it was seen inside the window. */
  record(key: string, t: number, now: number = nowSeconds()): boolean {
    this.prune(now)
    if (this.seen.has(key)) return false
    this.seen.set(key, t + this.windowSeconds)
    return true
  }

  get size(): number {
    return this.seen.size
  }

  private prune(now: number): void {
    if (now === this.lastPrune && this.seen.size < 10_000) return
    this.lastPrune = now
    for (const [key, expires] of this.seen) if (expires < now) this.seen.delete(key)
  }
}
