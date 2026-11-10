/* RenderEngine: the shape every engine implements. The orchestrator picks one by (format, output). */

import type { BrandIdentity, CompileError, OutputType, RenderFormat, TemplateField } from './common.js'

export interface EngineRenderRequest {
  source: string
  brand: BrandIdentity
  fields: TemplateField[]
  values: Record<string, unknown>
  output: OutputType
  engineConfig: Record<string, unknown>
}

export interface EngineRenderSuccess {
  ok: true
  bytes: Uint8Array
  mime: string
  warnings?: CompileError[]
}

export interface EngineRenderFailure {
  ok: false
  errors: CompileError[]
}

export type EngineRenderResult = EngineRenderSuccess | EngineRenderFailure

export interface RenderEngine {
  readonly format: RenderFormat
  readonly outputs: readonly OutputType[]
  render(req: EngineRenderRequest): Promise<EngineRenderResult>
}
