/* RenderController: the signed HTTP surface.

     POST /render         a template by name, or a source with its format; with `callback`, 202 and a signed POST
                          of the result later
     POST /preview        the same render, never with a callback
     POST /data/parse     CSV, JSON, YAML or TOML to records
     POST /data/validate  values against a list of fields
     GET  /templates      the templates this instance serves, with their fields and samples

   A render answers 200 with `ok: true`, or 422 with `ok: false` and its errors (a compile error, a refused file); a
   body that does not fit the request schema, or a value that does not fit its field, is a 400. */

import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import {
  RENDER_ENDPOINTS,
  parseDataRequestSchema,
  renderInputSchema,
  validateDataRequestSchema,
  type CompileError,
  type ParseDataRequest,
  type ParseDataResponse,
  type RenderInput,
  type RenderRequest,
  type RenderResponse,
  type ValidateDataRequest,
  type ValidateDataResponse,
} from '../contracts/index.js'
import { OrchestratorService } from './orchestrator.service.js'
import { DataParserService } from './data-parser.service.js'
import { DataValidatorService } from './data-validator.service.js'
import { TemplateRegistryService } from './template-registry.service.js'
import { RenderCallbackService } from './render-callback.service.js'
import { ZodValidationPipe } from '../common/zod-validation.pipe.js'

@Controller()
export class RenderController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly parser: DataParserService,
    private readonly validator: DataValidatorService,
    private readonly templates: TemplateRegistryService,
    private readonly callbacks: RenderCallbackService,
  ) {}

  private async renderInput(body: RenderInput): Promise<RenderResponse> {
    const resolved = this.templates.resolve(body)
    if (!resolved.ok) return { ok: false, errors: resolved.errors }
    return this.renderResolved(resolved.request, resolved.warnings)
  }

  /** A template's warnings go out with the engine's. */
  private async renderResolved(request: RenderRequest, warnings: CompileError[]): Promise<RenderResponse> {
    const result = await this.orchestrator.render(request)
    if (!result.ok || warnings.length === 0) return result
    return { ...result, warnings: [...(result.warnings ?? []), ...warnings] }
  }

  @Post(RENDER_ENDPOINTS.render)
  @HttpCode(200)
  async render(
    @Body(new ZodValidationPipe(renderInputSchema)) body: RenderInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RenderResponse | { accepted: true; jobId: string }> {
    if (!body.callback) return answered(reply, await this.renderInput(body))
    // A long render: refused now if it cannot call back, else accepted and run in the background
    const refusal = this.callbacks.refusal(body.callback.url)
    if (refusal) return answered(reply, { ok: false, errors: [refusal] })
    const resolved = this.templates.resolve(body)
    if (!resolved.ok) return answered(reply, { ok: false, errors: resolved.errors })
    const jobId = this.callbacks.newJobId(body.callback.id)
    void this.callbacks.runAndDeliver(body.callback.url, jobId, () => this.renderResolved(resolved.request, resolved.warnings))
    reply.status(202)
    return { accepted: true, jobId }
  }

  @Post(RENDER_ENDPOINTS.preview)
  @HttpCode(200)
  async preview(
    @Body(new ZodValidationPipe(renderInputSchema)) body: RenderInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RenderResponse> {
    return answered(reply, await this.renderInput(body))
  }

  @Get(RENDER_ENDPOINTS.templates)
  listTemplates() {
    return { templates: this.templates.list() }
  }

  @Post(RENDER_ENDPOINTS.parseData)
  @HttpCode(200)
  parseData(
    @Body(new ZodValidationPipe(parseDataRequestSchema)) body: ParseDataRequest,
  ): ParseDataResponse {
    return this.parser.parse(body)
  }

  @Post(RENDER_ENDPOINTS.validateData)
  @HttpCode(200)
  validateData(
    @Body(new ZodValidationPipe(validateDataRequestSchema))
    body: ValidateDataRequest,
  ): ValidateDataResponse {
    return this.validator.validate(body)
  }
}

/** A render that did not produce a document is a 422; its body says why. */
function answered(reply: FastifyReply, result: RenderResponse): RenderResponse {
  if (!result.ok) reply.status(422)
  return result
}
