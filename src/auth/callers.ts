/* The callers and their keys, from FABULA_HMAC_KEYS (a JSON object of caller name to hex key), checked at boot. */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.js'

@Injectable()
export class CallerRegistry {
  private readonly log = new Logger('CallerRegistry')
  private readonly secrets = new Map<string, string>()

  constructor(config: ConfigService<Env, true>) {
    const keys = config.get('FABULA_HMAC_KEYS', { infer: true })
    for (const [caller, hex] of Object.entries(keys)) {
      this.secrets.set(caller, hex)
    }
    this.log.log(`callers: ${[...this.secrets.keys()].join(', ') || '(none)'}`)
  }

  /** The hex key of a known caller, or null. */
  getSecretHex(caller: string): string | null {
    return this.secrets.get(caller) ?? null
  }

  hasCaller(caller: string): boolean {
    return this.secrets.has(caller)
  }
}
