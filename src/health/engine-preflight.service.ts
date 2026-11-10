/* EnginePreflightService: at boot, `<binary> --version` once for every enabled engine, cached for the health routes.
   A missing binary never stops the boot: with FABULA_REQUIRE_ENGINES=true it is logged as an error and /readyz
   answers 503; with false, a warning. MJML is a Node dependency and is read from its package.json. Pandoc's and
   Quarto's PDFs need Typst too; that is Typst's own line. */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import type { Env } from '../config/env.js'
import { ENGINE_NAMES, settings, type EngineName } from '../config/settings.js'

const require = createRequire(import.meta.url)

export interface EnginePreflightResult {
  /** Every engine: its version, or null when it is enabled and missing; engines left out are absent. */
  versions: Partial<Record<EngineName, string | null>>
  /** The enabled engines whose binary was not found. */
  missing: EngineName[]
}

@Injectable()
export class EnginePreflightService implements OnApplicationBootstrap {
  private readonly log = new Logger('EnginePreflight')
  private readonly required: boolean
  private result: EnginePreflightResult | null = null

  constructor(config: ConfigService<Env, true>) {
    this.required = config.get('FABULA_REQUIRE_ENGINES', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    const enabled = ENGINE_NAMES.filter((e) => settings().engines.has(e))
    const found = await Promise.all(enabled.map((e) => (e === 'mjml' ? Promise.resolve(readMjmlVersion()) : runVersion(binaryOf(e)))))
    const versions = Object.fromEntries(enabled.map((e, i) => [e, found[i]])) as EnginePreflightResult['versions']
    const missing = enabled.filter((e) => !versions[e])
    this.result = { versions, missing }

    for (const e of enabled) {
      const v = versions[e]
      if (v) this.log.log(`✓ ${e} ${v}`)
      else if (this.required) this.log.error(`✗ ${e} NOT FOUND (${binaryOf(e)}): its renders will fail; /readyz answers 503`)
      else this.log.warn(`✗ ${e} not found (${binaryOf(e)}); FABULA_REQUIRE_ENGINES=false`)
    }
  }

  /** The cached result, or null before the preflight has run. */
  getResult(): EnginePreflightResult | null {
    return this.result
  }

  /** Whether a missing engine keeps /readyz at 503 (FABULA_REQUIRE_ENGINES). */
  isGateEnabled(): boolean {
    return this.required
  }
}

function binaryOf(engine: EngineName): string {
  return engine === 'chromium' ? settings().chromiumPath : engine
}

/** `<bin> --version`, its first version-like token; null on any failure. */
function runVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
    proc.stdout.on('data', (c) => chunks.push(c as Buffer))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      const out = Buffer.concat(chunks).toString('utf-8').trim()
      const m = out.match(/(\d+\.\d+(?:\.\d+)*)/)
      resolve(m?.[1] ?? (out.split('\n')[0] || null))
    })
  })
}

function readMjmlVersion(): string | null {
  try {
    return (require('mjml/package.json') as { version: string }).version ?? null
  } catch {
    return null
  }
}
