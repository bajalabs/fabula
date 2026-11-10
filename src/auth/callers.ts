/* The callers and their secrets: FABULA_HMAC_KEYS (caller → hex key) with FABULA_AUTH=hmac, FABULA_TOKENS
   (caller → bearer token) with FABULA_AUTH=token. Both are checked at boot. */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Env } from '../config/env.js'

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

@Injectable()
export class CallerRegistry {
  readonly mode: 'hmac' | 'token'
  private readonly secrets = new Map<string, string>()
  private readonly tokens: Array<{ caller: string; digest: Buffer }> = []

  constructor(config: ConfigService<Env, true>) {
    this.mode = config.get('FABULA_AUTH', { infer: true }) ?? 'hmac'
    for (const [caller, hex] of Object.entries(config.get('FABULA_HMAC_KEYS', { infer: true }) ?? {})) this.secrets.set(caller, hex)
    for (const [caller, token] of Object.entries(config.get('FABULA_TOKENS', { infer: true }) ?? {})) this.tokens.push({ caller, digest: digest(token) })
    const names = this.mode === 'hmac' ? [...this.secrets.keys()] : this.tokens.map((t) => t.caller)
    new Logger('CallerRegistry').log(`auth ${this.mode}, callers: ${names.join(', ') || '(none)'}`)
  }

  /** The hex key of a known caller, or null. */
  getSecretHex(caller: string): string | null {
    return this.secrets.get(caller) ?? null
  }

  hasCaller(caller: string): boolean {
    return this.secrets.has(caller) || this.tokens.some((t) => t.caller === caller)
  }

  /** The caller a bearer token belongs to, or null. Every token is compared, in constant time, by its digest. */
  callerForToken(token: string): string | null {
    const d = digest(token)
    let found: string | null = null
    for (const t of this.tokens) if (timingSafeEqual(d, t.digest) && found === null) found = t.caller
    return found
  }
}
