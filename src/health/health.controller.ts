/* HealthController, three public routes:

     GET /health   the engines and their versions, and the uptime. Always 200.
     GET /healthz  liveness: the process answers. Always 200.
     GET /readyz   readiness: 200 once the engine preflight has run and, with ENGINE_PREFLIGHT_REQUIRED=true, every
                   engine binary was found; 503 otherwise, so a load balancer holds traffic back. */

import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type {
  HealthResponse,
  RenderFormat,
} from '../contracts/index.js'
import { RENDER_ENDPOINTS } from '../contracts/index.js'
import { Public } from '../auth/public.decorator.js'
import { EnginePreflightService } from './engine-preflight.service.js'

const startedAt = Date.now()

interface MinimalProbeResponse {
  status: 'ok' | 'not_ready'
  uptimeSec: number
}

@Public()
@Controller()
export class HealthController {
  constructor(private readonly preflight: EnginePreflightService) {}

  @Get(RENDER_ENDPOINTS.health)
  health(): HealthResponse {
    const result = this.preflight.getResult()
    const bins = result?.binaries ?? {
      typst: null,
      pandoc: null,
      quarto: null,
      weasyprint: null,
    }

    const engines: RenderFormat[] = []
    if (bins.typst) engines.push('typst')
    if (bins.pandoc) engines.push('markdown')
    if (bins.quarto) engines.push('quarto')
    if (bins.weasyprint) engines.push('html')
    if (result?.mjmlVersion) engines.push('mjml')

    return {
      // 'ready' when Typst is present (the PDF path most templates take), else 'degraded'
      status: bins.typst ? 'ready' : 'degraded',
      engines,
      typstVersion: bins.typst,
      pandocVersion: bins.pandoc,
      quartoVersion: bins.quarto,
      weasyprintVersion: bins.weasyprint,
      mjmlVersion: result?.mjmlVersion ?? null,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }
  }

  /** The process is up and its event loop answers; no engine is needed. */
  @Get('/healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): MinimalProbeResponse {
    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }
  }

  /** 503 until the preflight has run and, when it is required, every engine binary was found. */
  @Get('/readyz')
  readiness(): MinimalProbeResponse {
    const result = this.preflight.getResult()

    if (!result) {
      throw new HttpException(
        {
          status: 'not_ready',
          reason: 'preflight-incomplete',
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    if (this.preflight.isGateEnabled() && !result.allBinariesPresent) {
      throw new HttpException(
        {
          status: 'not_ready',
          reason: 'missing-binaries',
          missing: result.missingBinaries,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }
  }
}
