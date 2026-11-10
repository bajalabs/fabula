import { Module } from '@nestjs/common'
import { ClsModule } from 'nestjs-cls'
import type { FastifyRequest } from 'fastify'

function extractTraceId(req: FastifyRequest): string | undefined {
  const tp = req.headers.traceparent
  if (typeof tp !== 'string') return undefined
  const parts = tp.split('-')
  return parts.length >= 2 && parts[1] ? parts[1] : undefined
}

/** A request's context: its id and its W3C trace id, for every log line written while it runs. */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: false,
        setup: (cls, req: FastifyRequest) => {
          cls.set('requestId', String(req.id ?? ''))
          const traceId = extractTraceId(req)
          if (traceId) cls.set('traceId', traceId)
        },
      },
    }),
  ],
})
export class AppClsModule {}
