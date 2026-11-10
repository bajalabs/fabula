/* Fabula bootstrap: NestJS on Fastify, bound to $HOST:$PORT. The raw body is kept for the signature check. */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { ConfigService } from '@nestjs/config'
import { Logger as PinoLogger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import type { Env } from './config/env.js'
import { answerRequestId, genReqId } from './common/request-id.js'

const BODY_LIMIT_BYTES = 8 * 1024 * 1024 // template sources and data

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: BODY_LIMIT_BYTES,
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

  const config = app.get(ConfigService<Env, true>)
  const port = config.get('PORT', { infer: true })
  const host = config.get('HOST', { infer: true })

  await app.listen(port, host)
  app.get(PinoLogger).log(`fabula listening on ${host}:${port}`, 'Bootstrap')
}

bootstrap().catch((err) => {
  console.error('[fabula] bootstrap failed', err)
  process.exit(1)
})
