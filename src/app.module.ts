import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from './config/config.module.js'
import { LoggerModule } from './common/logger.module.js'
import { AppClsModule } from './common/cls.module.js'
import { AuthModule } from './auth/auth.module.js'
import { AuthGuard } from './auth/auth.guard.js'
import { RenderModule } from './render/render.module.js'
import { HealthModule } from './health/health.module.js'

@Module({
  imports: [
    // The environment is validated first: a missing or malformed variable stops the boot
    ConfigModule,
    LoggerModule,
    AppClsModule,
    AuthModule,
    RenderModule,
    // /health, /healthz and /readyz are public
    HealthModule,
  ],
  providers: [
    // Every route is signed unless it is marked @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
