import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'
import { EnginePreflightService } from './engine-preflight.service.js'

@Module({
  controllers: [HealthController],
  providers: [EnginePreflightService],
  exports: [EnginePreflightService],
})
export class HealthModule {}
