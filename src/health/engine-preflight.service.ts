/* EnginePreflightService: at boot, `<bin> --version` once for every engine binary, cached for the health routes.
   A missing binary never stops the boot: with ENGINE_PREFLIGHT_REQUIRED=true it is logged as an error and /readyz
   answers 503; with false, a warning. MJML is a Node dependency and is read from its package.json. */

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import type { Env } from '../config/env.js'

const require = createRequire(import.meta.url)

/** The engine binaries Fabula spawns. */
const SUBPROCESS_BINARIES = ['typst', 'pandoc', 'quarto', 'weasyprint'] as const
type SubprocessBinary = (typeof SUBPROCESS_BINARIES)[number]

export interface EnginePreflightResult {
  /** Map of binary name → version string ('1.2.3') or null when
   *  the binary is not on $PATH or returned non-zero. */
  binaries: Record<SubprocessBinary, string | null>
  /** mjml package version (in-process, always available unless the
   *  package is missing — which would have been a build failure). */
  mjmlVersion: string | null
  /** Convenience: true if every subprocess binary returned a version. */
  allBinariesPresent: boolean
  /** Convenience: list of names of missing binaries. */
  missingBinaries: SubprocessBinary[]
}

@Injectable()
export class EnginePreflightService implements OnApplicationBootstrap {
  private readonly log = new Logger('EnginePreflight')
  private readonly required: boolean
  private result: EnginePreflightResult | null = null

  constructor(config: ConfigService<Env, true>) {
    this.required = config.get('ENGINE_PREFLIGHT_REQUIRED', { infer: true })
  }

  /** Called once after every module is initialised, before app.listen() returns; the binaries are probed in parallel. */
  async onApplicationBootstrap(): Promise<void> {
    const versions = await Promise.all(
      SUBPROCESS_BINARIES.map((bin) => runVersion(bin)),
    )
    const binaries = Object.fromEntries(
      SUBPROCESS_BINARIES.map((bin, i) => [bin, versions[i] ?? null]),
    ) as Record<SubprocessBinary, string | null>

    const missingBinaries = SUBPROCESS_BINARIES.filter((b) => !binaries[b])
    const allBinariesPresent = missingBinaries.length === 0

    this.result = {
      binaries,
      mjmlVersion: readMjmlVersion(),
      allBinariesPresent,
      missingBinaries,
    }

    for (const bin of SUBPROCESS_BINARIES) {
      const version = binaries[bin]
      if (version) {
        this.log.log(`✓ ${bin} ${version}`)
      } else if (this.required) {
        this.log.error(
          `✗ ${bin} NOT FOUND — engines depending on it will fail. Check the image build.`,
        )
      } else {
        this.log.warn(`✗ ${bin} not on $PATH (preflight gate disabled)`)
      }
    }

    if (this.result.mjmlVersion) {
      this.log.log(`✓ mjml ${this.result.mjmlVersion}`)
    } else {
      this.log.warn('✗ mjml package missing — MjmlEngine will fail')
    }

    if (this.required && !allBinariesPresent) {
      this.log.error(
        `preflight gate FAILED: missing ${missingBinaries.join(', ')}. ` +
          `/readyz will return 503 until these are present.`,
      )
    }
  }

  /** The cached result, or null before the preflight has run. */
  getResult(): EnginePreflightResult | null {
    return this.result
  }

  /** Whether the preflight gate is enabled (ENGINE_PREFLIGHT_REQUIRED). */
  isGateEnabled(): boolean {
    return this.required
  }
}

// ── helpers ────────────────────────────────────────────────────────

/** `<bin> --version`, its first version-like token; null on any failure. */
function runVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    proc.stdout.on('data', (c) => chunks.push(c as Buffer))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const out = Buffer.concat(chunks).toString('utf-8').trim()
      const m = out.match(/(\d+\.\d+(?:\.\d+)?)/)
      resolve(m?.[1] ?? out.split('\n')[0] ?? null)
    })
  })
}

function readMjmlVersion(): string | null {
  try {
    const pkg = require('mjml/package.json') as { version: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
