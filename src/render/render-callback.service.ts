/* RenderCallbackService: a long render calls back, signed.

   A render request with `callback: { url, id? }` is accepted at once (202 with the job id); the render runs in the
   background and its result (the body /render would have answered, plus the job id) is POSTed to the URL, signed as
   caller `fabula` with FABULA_CALLBACK_KEY, in the same scheme callers use (src/auth/signature.ts):

     x-fabula-caller:    fabula
     x-fabula-signature: t=<unix seconds>,v1=<hex>
     message:            `${caller}.${t}.${METHOD}.${pathWithQuery}.${rawBody}`

   The URL's host and port must be on FABULA_CALLBACK_HOSTS (`host:port`, or `host` for the scheme's default port),
   so a signed caller cannot point Fabula anywhere else, and no redirect is followed: an answer of 3xx is a refusal.
   Up to three attempts (0 s, 2 s, 8 s), each with a 10 s limit; the result of the last attempt is logged, never the
   body. */

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, randomUUID } from 'node:crypto'
import type { Env } from '../config/env.js'
import { CALLER_HEADER, SIGNATURE_HEADER } from '../auth/signature.js'
import type { CompileError, RenderResponse } from '../contracts/index.js'

export const CALLBACK_CALLER = 'fabula'
export const CALLBACK_TIMEOUT_MS = 10_000
export const CALLBACK_BACKOFF_MS = [0, 2_000, 8_000] as const

export interface CallbackEvent {
  jobId: string
  event: 'render.completed' | 'render.failed'
  result: RenderResponse
}

/** The exact request a call-back sends: serialised once, signed over that string. */
export function signCallback(url: URL, body: string, hexKey: string, t: number = Math.floor(Date.now() / 1000)): Record<string, string> {
  const message = `${CALLBACK_CALLER}.${t}.POST.${url.pathname}${url.search}.${body}`
  const v1 = createHmac('sha256', Buffer.from(hexKey, 'hex')).update(message).digest('hex')
  return { 'content-type': 'application/json', [CALLER_HEADER]: CALLBACK_CALLER, [SIGNATURE_HEADER]: `t=${t},v1=${v1}` }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

/** `hosts` as FABULA_CALLBACK_HOSTS gives them: lower case, `host:port`, or `host` for the scheme's default port. */
export function callbackHostAllowed(url: URL, hosts: readonly string[]): boolean {
  const fallback = DEFAULT_PORTS[url.protocol]
  const port = url.port || fallback
  return hosts.some((entry) => {
    const [name, listed] = entry.split(':')
    return name === url.hostname.toLowerCase() && (listed ?? fallback) === port
  })
}

@Injectable()
export class RenderCallbackService {
  private readonly log = new Logger('RenderCallback')
  /** Swapped in specs; the global fetch otherwise. */
  fetch: Fetch = (input, init) => fetch(input, init)
  /** Swapped in specs so retries do not wait. */
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  constructor(private readonly config: ConfigService<Env, true>) {
    if (config.get('FABULA_CALLBACK_HOSTS', { infer: true }).length === 0) {
      this.log.warn('FABULA_CALLBACK_HOSTS is not set: every call-back is refused')
    }
  }

  /** Why this callback cannot be accepted, or null when it can. */
  refusal(callbackUrl: string): CompileError | null {
    if (!this.config.get('FABULA_CALLBACK_KEY', { infer: true })) {
      return { severity: 'error', message: 'FABULA_CALLBACK_KEY is not set: call-backs cannot be signed', file: 'callback' }
    }
    let url: URL
    try {
      url = new URL(callbackUrl)
    } catch {
      return { severity: 'error', message: 'callback.url is not a URL', file: 'callback' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { severity: 'error', message: 'callback.url must be http(s)', file: 'callback' }
    }
    const hosts = this.config.get('FABULA_CALLBACK_HOSTS', { infer: true })
    if (!callbackHostAllowed(url, hosts)) {
      return { severity: 'error', message: `callback host ${url.host} is not one Fabula calls back`, file: 'callback' }
    }
    return null
  }

  newJobId(requested?: string): string {
    return requested ?? randomUUID()
  }

  /** Run the render, then deliver its result; never throws (a failure is logged and, when possible, delivered). */
  async runAndDeliver(callbackUrl: string, jobId: string, render: () => Promise<RenderResponse>): Promise<{ delivered: boolean; status: number | null }> {
    let result: RenderResponse
    try {
      result = await render()
    } catch (err) {
      const status = (err as { getStatus?: () => number }).getStatus?.()
      result = {
        ok: false,
        errors: [{ severity: 'error', message: status === 429 ? 'Fabula was at capacity; try again' : `render threw: ${err instanceof Error ? err.message : String(err)}` }],
      }
    }
    return this.deliver(callbackUrl, { jobId, event: result.ok ? 'render.completed' : 'render.failed', result })
  }

  async deliver(callbackUrl: string, event: CallbackEvent): Promise<{ delivered: boolean; status: number | null }> {
    const key = this.config.get('FABULA_CALLBACK_KEY', { infer: true })
    if (!key) return { delivered: false, status: null }
    const url = new URL(callbackUrl)
    const body = JSON.stringify(event)
    let status: number | null = null
    for (const wait of CALLBACK_BACKOFF_MS) {
      if (wait) await this.sleep(wait)
      try {
        const res = await this.fetch(url.toString(), { method: 'POST', headers: signCallback(url, body, key), body, redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) })
        status = res.status
        void res.body?.cancel().catch(() => undefined)
        if (res.ok) {
          this.log.log(`job ${event.jobId}: ${event.event} delivered to ${url.host} (${res.status})`)
          return { delivered: true, status }
        }
        // A redirect is not followed and not retried: it would take a signed result off the listed host
        if (res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429) break
      } catch (err) {
        status = null
        this.log.warn(`job ${event.jobId}: call-back to ${url.host} failed (${err instanceof Error ? err.name : 'error'})`)
      }
    }
    this.log.error(`job ${event.jobId}: ${event.event} not delivered to ${url.host} (last status ${status ?? 'none'})`)
    return { delivered: false, status }
  }
}
