/* The pino options: JSON lines in production, pretty in development, credentials redacted, the request id and the
   W3C trace id on every line. */

import type { LoggerOptions } from 'pino'

export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-fabula-signature"]',
  '*.password',
  '*.secret',
  '*.secretKey',
  '*.apiKey',
  '*.token',
  '*.access_token',
  '*.refresh_token',
] as const

export const REDACT_CENSOR = '[REDACTED]'

function extractTraceId(traceparent: string | string[] | undefined): string | undefined {
  if (typeof traceparent !== 'string') return undefined
  // W3C traceparent: 00-<trace-id>-<parent-id>-<flags>
  const parts = traceparent.split('-')
  return parts.length >= 2 && parts[1] ? parts[1] : undefined
}

export interface CreatePinoOptionsArgs {
  level?: string
  /** pino-pretty instead of JSON lines. */
  pretty?: boolean
  extraRedactPaths?: string[]
}

export function createPinoOptions(args: CreatePinoOptionsArgs = {}): LoggerOptions {
  const opts: LoggerOptions = {
    level: args.level ?? 'info',
    redact: { paths: [...REDACT_PATHS, ...(args.extraRedactPaths ?? [])], censor: REDACT_CENSOR },
  }
  if (args.pretty) {
    opts.transport = {
      target: 'pino-pretty',
      options: { singleLine: false, colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    }
  }
  return opts
}

interface HttpRequestLike {
  id?: string
  headers: Record<string, string | string[] | undefined>
}

export interface PinoHttpOptions extends LoggerOptions {
  customProps?: (req: unknown) => Record<string, unknown>
}

/** The pinoHttp options for nestjs-pino: the base options plus request_id and trace_id on every line. */
export function createHttpLoggerOptions(args: CreatePinoOptionsArgs = {}): PinoHttpOptions {
  return {
    ...createPinoOptions(args),
    customProps: (req: unknown) => {
      const r = req as HttpRequestLike
      return { request_id: r.id, trace_id: extractTraceId(r.headers.traceparent) }
    },
  }
}
