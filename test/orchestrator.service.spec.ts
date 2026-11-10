/* OrchestratorService: dispatch, the concurrency cap and the drain. Covered: 429 above
   FABULA_MAX_CONCURRENT_RENDERS; 503 once shutting down; the counters; an engine miss as a structured error, not a
   throw. Fake engines resolve after a delay; ConfigService is a stub. */

import { describe, expect, it, vi } from 'vitest'
import { HttpException, HttpStatus } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type {
  RenderRequest,
  RenderFormat,
  OutputType,
} from '../src/contracts/index.js'
import { OrchestratorService } from '../src/render/orchestrator.service.js'
import type { Env } from '../src/config/env.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../src/contracts/engine.js'

/** A configurable fake engine — resolves to PNG bytes after `delayMs`. */
function makeFakeEngine(
  format: RenderFormat,
  outputs: OutputType[],
  delayMs = 0,
): RenderEngine {
  return {
    format,
    outputs,
    async render(_req: EngineRenderRequest): Promise<EngineRenderResult> {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
      return {
        ok: true,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG magic
        mime: 'image/png',
      }
    },
  }
}

function makeConfig(opts: {
  maxConcurrent?: number
  drainSeconds?: number
}): ConfigService<Env, true> {
  return {
    get: (key: string) => {
      if (key === 'FABULA_MAX_CONCURRENT_RENDERS')
        return opts.maxConcurrent ?? 4
      if (key === 'SHUTDOWN_DRAIN_SECONDS') return opts.drainSeconds ?? 1
      return undefined
    },
  } as unknown as ConfigService<Env, true>
}

/** Build an orchestrator with one fake engine for each common (format,
 *  output) pair the tests need. */
function makeOrchestrator(
  config: ConfigService<Env, true>,
  delayMs = 0,
): OrchestratorService {
  // The constructor takes 7 engines + config. We only need typst+chromium
  // here, but the constructor signature requires all 7 — so we pass
  // fakes for the unused ones too.
  const fake = (format: RenderFormat, outputs: OutputType[]) =>
    makeFakeEngine(format, outputs, delayMs) as never
  return new OrchestratorService(
    fake('typst', ['pdf']),
    fake('markdown', ['pdf', 'html']),
    fake('quarto', ['pdf', 'html']),
    fake('html', ['pdf']),
    fake('mjml', ['html']),
    config,
  )
}

const REQ = {
  format: 'typst' as const,
  output: 'pdf' as const,
  source: '#set page(width: 100mm)',
  fields: [],
  values: {},
} as unknown as RenderRequest

describe('OrchestratorService', () => {
  it('returns rendered bytes on a happy-path dispatch', async () => {
    const orch = makeOrchestrator(makeConfig({ maxConcurrent: 4 }))
    const res = await orch.render(REQ)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mime).toBe('image/png')
      // bytes are base64 of the 4 PNG magic bytes
      expect(Buffer.from(res.bytes, 'base64')).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      )
    }
    expect(orch.getRenderCount()).toBe(1)
    expect(orch.getInFlight()).toBe(0) // released in finally
  })

  it('returns a structured error when no engine matches', async () => {
    const orch = makeOrchestrator(makeConfig({ maxConcurrent: 4 }))
    const bogus = { ...REQ, format: 'pdf' as RenderFormat, output: 'gif' as OutputType }
    const res = await orch.render(bogus as RenderRequest)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors[0]?.message).toMatch(/No engine registered/)
    }
    // Engine miss happens BEFORE inFlight increment — counter is untouched
    expect(orch.getRenderCount()).toBe(0)
    expect(orch.getInFlight()).toBe(0)
  })

  it('rejects with 429 when at concurrency cap', async () => {
    const orch = makeOrchestrator(makeConfig({ maxConcurrent: 2 }), 50)
    // Fire 2 in-flight renders that take 50ms each
    const p1 = orch.render(REQ)
    const p2 = orch.render(REQ)
    // The 3rd is rejected with 429 BEFORE any await inside render()
    // (guardAcceptingWork throws synchronously; the throw becomes a
    // promise rejection on the async function's return value).
    try {
      await orch.render(REQ)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException)
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      )
      const body = (err as HttpException).getResponse() as {
        error: string
        max: number
      }
      expect(body.error).toBe('too_many_renders')
      expect(body.max).toBe(2)
    }
    await Promise.all([p1, p2])
  })

  it('rejects with 503 once shutdown drain has started', async () => {
    const orch = makeOrchestrator(makeConfig({ maxConcurrent: 4, drainSeconds: 0 }))
    // Trigger drain manually — onApplicationShutdown sets shuttingDown=true
    await orch.onApplicationShutdown()
    try {
      await orch.render(REQ)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException)
      expect((err as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
      const body = (err as HttpException).getResponse() as { error: string }
      expect(body.error).toBe('shutting_down')
    }
  })

  it('does not increment renderCount on a rejected render (429)', async () => {
    const orch = makeOrchestrator(makeConfig({ maxConcurrent: 1 }), 30)
    const p1 = orch.render(REQ) // takes 30ms
    try {
      await orch.render(REQ) // immediate 429
    } catch {
      // expected
    }
    await p1
    // Only 1 render actually ran — the rejected one didn't move the counter
    expect(orch.getRenderCount()).toBe(1)
  })

  it('decrements inFlight even when the engine throws', async () => {
    const failingEngine: RenderEngine = {
      format: 'typst',
      outputs: ['pdf'],
      render: vi.fn(async () => {
        throw new Error('engine boom')
      }),
    }
    const config = makeConfig({ maxConcurrent: 4 })
    // Hand-build orchestrator with the failing engine in slot 1
    const orch = new OrchestratorService(
      failingEngine as never,
      makeFakeEngine('markdown', ['pdf', 'html']) as never,
      makeFakeEngine('quarto', ['pdf', 'html']) as never,
      makeFakeEngine('html', ['pdf']) as never,
      makeFakeEngine('mjml', ['html']) as never,
      config,
    )
    const res = await orch.render(REQ)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors[0]?.message).toMatch(/engine boom/)
    }
    expect(orch.getInFlight()).toBe(0) // released in finally despite throw
  })
})
