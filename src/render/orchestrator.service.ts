/* OrchestratorService: a render request goes to the first engine registered for its (format, output).

   At most FABULA_MAX_CONCURRENT_RENDERS renders run at once per process; above it a render is refused with 429.
   On SIGTERM new renders are refused with 503 while the ones in flight get SHUTDOWN_DRAIN_SECONDS to finish, so an
   engine subprocess can write its output before Node exits. */

import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type {
  RenderRequest,
  RenderResponse,
  CompileError,
} from '../contracts/index.js'
import type { Env } from '../config/env.js'
import { TypstEngine } from './engines/typst.engine.js'
import { PandocEngine } from './engines/pandoc.engine.js'
import { QuartoEngine } from './engines/quarto.engine.js'
import { WeasyPrintEngine } from './engines/weasyprint.engine.js'
import { MjmlEngine } from './engines/mjml.engine.js'
import { PagePreviewService } from './page-preview.service.js'
import { issuesAsErrors, parseRequestValues } from './document-fields.js'
import type { RenderEngine } from '../contracts/engine.js'

@Injectable()
export class OrchestratorService implements OnApplicationShutdown {
  private readonly logger = new Logger('Orchestrator')
  private readonly engines: ReadonlyArray<RenderEngine>
  private readonly maxConcurrent: number
  private readonly drainSeconds: number
  private renderCount = 0
  private inFlight = 0
  private shuttingDown = false

  constructor(
    private readonly typst: TypstEngine,
    private readonly pandoc: PandocEngine,
    private readonly quarto: QuartoEngine,
    private readonly weasyprint: WeasyPrintEngine,
    private readonly mjml: MjmlEngine,
    config: ConfigService<Env, true>,
    // Page previews; optional so a bare orchestrator still renders
    @Optional() private readonly pagePreviews?: PagePreviewService,
  ) {
    // Registration order is dispatch priority
    this.engines = [
      this.typst,
      this.pandoc,
      // a finished .docx read back to the final PDF or HTML; a fake Pandoc in a spec may not have it
      ...(typeof this.pandoc.asDocxReader === 'function' ? [this.pandoc.asDocxReader()] : []),
      this.quarto,
      this.weasyprint,
      this.mjml,
    ]
    this.maxConcurrent = config.get('FABULA_MAX_CONCURRENT_RENDERS', {
      infer: true,
    })
    this.drainSeconds = config.get('SHUTDOWN_DRAIN_SECONDS', { infer: true })
    this.logger.log(
      `dispatch ready — ${this.engines.length} engines, ` +
        `max concurrent ${this.maxConcurrent}, ` +
        `shutdown drain ${this.drainSeconds}s`,
    )
  }

  readonly registeredFormats = (): ReadonlyArray<RenderRequest['format']> =>
    Array.from(new Set(this.engines.map((e) => e.format)))

  getRenderCount(): number {
    return this.renderCount
  }

  getInFlight(): number {
    return this.inFlight
  }

  /** Drain the renders in flight before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true // refuse new renders → 503
    if (this.inFlight === 0) return
    this.logger.log(
      `draining ${this.inFlight} in-flight renders ` +
        `(timeout ${this.drainSeconds}s)`,
    )
    const start = Date.now()
    const drainMs = this.drainSeconds * 1000
    while (this.inFlight > 0 && Date.now() - start < drainMs) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (this.inFlight > 0) {
      this.logger.warn(
        `drain timeout — ${this.inFlight} renders still in flight ` +
          `(will be aborted by process exit)`,
      )
    } else {
      this.logger.log(`drain complete in ${Date.now() - start}ms`)
    }
  }

  private findEngine(req: RenderRequest): RenderEngine | undefined {
    return this.engines.find(
      (e) => e.format === req.format && e.outputs.includes(req.output),
    )
  }

  /** Throws when shutting down (503) or at capacity (429), before a slot is taken. */
  private guardAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new HttpException(
        {
          error: 'shutting_down',
          message: 'fabula is draining; new renders refused',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    if (this.inFlight >= this.maxConcurrent) {
      throw new HttpException(
        {
          error: 'too_many_renders',
          message: `at capacity: ${this.inFlight}/${this.maxConcurrent} renders in flight`,
          inFlight: this.inFlight,
          max: this.maxConcurrent,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  async render(req: RenderRequest): Promise<RenderResponse> {
    this.guardAcceptingWork()
    const startedAt = Date.now()
    const engine = this.findEngine(req)
    if (!engine) {
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: `No engine registered for format="${req.format}" output="${req.output}".`,
          },
        ],
        durationMs: Date.now() - startedAt,
      }
    }

    // Every value by its field's type, whatever the engine and however the request came: a value that does not fit
    // is refused before an engine sees it (the controller already answered 400 for a request it resolved)
    const values = parseRequestValues(req.fields, req.values)
    if (!values.ok) return { ok: false, errors: issuesAsErrors(values.issues), durationMs: Date.now() - startedAt }

    this.inFlight += 1
    this.renderCount += 1
    try {
      const result = await engine.render({
        source: req.source,
        brand: req.brand,
        fields: req.fields,
        values: values.values,
        output: req.output,
        engineConfig: req.engineConfig ?? {},
      })

      if (result.ok && req.previews) {
        // A PNG of every page, beside the PDF; an HTML output has no pages to show
        if (result.mime !== 'application/pdf') {
          return {
            ok: false,
            errors: [{ severity: 'error', message: `previews need a PDF output, not ${req.output}`, file: 'previews' }],
            durationMs: Date.now() - startedAt,
          }
        }
        if (!this.pagePreviews) {
          return {
            ok: false,
            errors: [{ severity: 'error', message: 'page previews are not available in this process', file: 'previews' }],
            durationMs: Date.now() - startedAt,
          }
        }
        const shots = await this.pagePreviews.rasterise(result.bytes, req.previews)
        if (!shots.ok) return { ok: false, errors: shots.errors, durationMs: Date.now() - startedAt }
        return {
          ok: true,
          mime: result.mime,
          bytes: Buffer.from(result.bytes).toString('base64'),
          durationMs: Date.now() - startedAt,
          warnings: result.warnings,
          pages: shots.pages,
          pageCount: shots.pageCount,
        }
      }

      const durationMs = Date.now() - startedAt
      if (result.ok) {
        return {
          ok: true,
          mime: result.mime,
          bytes: Buffer.from(result.bytes).toString('base64'),
          durationMs,
          warnings: result.warnings,
        }
      }
      return { ok: false, errors: result.errors, durationMs }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `Render failed: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      )
      const errors: CompileError[] = [
        { severity: 'error', message: `Render threw: ${msg}` },
      ]
      return { ok: false, errors, durationMs }
    } finally {
      this.inFlight -= 1
    }
  }
}
