import { Module } from '@nestjs/common'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'
import { ConfigService } from '@nestjs/config'
import { createHttpLoggerOptions } from './pino-config.js'
import type { Env } from '../config/env.js'

/** Structured logging through nestjs-pino: JSON lines, pretty when NODE_ENV=development. */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: createHttpLoggerOptions({
          level: config.get('LOG_LEVEL', { infer: true }),
          pretty: config.get('NODE_ENV', { infer: true }) === 'development',
        }),
      }),
    }),
  ],
})
export class LoggerModule {}
