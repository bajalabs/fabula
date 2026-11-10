/* HealthController, three public routes:

     GET /health   every enabled engine and its version (null when its binary is missing), and the uptime. Always
                   200; `status` is `ready` when every enabled engine was found, else `degraded`.
     GET /healthz  liveness: the process answers. Always 200.
     GET /readyz   readiness: 200 once the engine preflight has run and, with FABULA_REQUIRE_ENGINES=true (the
                   default), every enabled engine was found; 503 otherwise, so a load balancer holds traffic back. */

import { Controller, Get, HttpCode, HttpException, HttpStatus } from '@nestjs/common'
import type { HealthResponse } from '../contracts/index.js'
import { RENDER_ENDPOINTS } from '../contracts/index.js'
import { Public } from '../auth/public.decorator.js'
import { EnginePreflightService } from './engine-preflight.service.js'

const startedAt = Date.now()
const uptimeSec = () => Math.round((Date.now() - startedAt) / 1000)

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
    return {
      status: result && result.missing.length === 0 ? 'ready' : 'degraded',
      engines: result?.versions ?? {},
      uptimeSec: uptimeSec(),
    }
  }

  @Get('/healthz')
  @HttpCode(HttpStatus.OK)
  liveness(): MinimalProbeResponse {
    return { status: 'ok', uptimeSec: uptimeSec() }
  }

  @Get('/readyz')
  readiness(): MinimalProbeResponse {
    const result = this.preflight.getResult()
    if (!result) {
      throw new HttpException({ status: 'not_ready', reason: 'preflight-incomplete', uptimeSec: uptimeSec() }, HttpStatus.SERVICE_UNAVAILABLE)
    }
    if (this.preflight.isGateEnabled() && result.missing.length > 0) {
      throw new HttpException(
        { status: 'not_ready', reason: 'missing-engines', missing: result.missing, uptimeSec: uptimeSec() },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return { status: 'ok', uptimeSec: uptimeSec() }
  }
}
