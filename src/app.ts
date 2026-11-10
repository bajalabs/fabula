/* The application: NestJS on Fastify with the raw body kept for the signature check and the request id answered on
   every response. main.ts listens with it; the HTTP spec drives it with Fastify's inject. */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger as PinoLogger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import type { Env } from './config/env.js'
import { answerRequestId, genReqId } from './common/request-id.js'

export async function createApp(env: Env): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: env.FABULA_BODY_LIMIT_BYTES,
      trustProxy: true,
      genReqId,
      requestIdHeader: false,
    }),
    {
      bufferLogs: true,
      // The guard verifies the signature over the bytes as they arrived; a re-serialised body would not match.
      rawBody: true,
    },
  )
  app.getHttpAdapter().getInstance().addHook('onRequest', answerRequestId)
  app.useLogger(app.get(PinoLogger))
  // SIGTERM drains the renders in flight before the process exits
  app.enableShutdownHooks()
  return app
}
