/* A small Chrome DevTools Protocol client over --remote-debugging-pipe: Chromium reads commands on its fd 3 and writes
   answers and events on its fd 4, each message one JSON text ended by a NUL byte. No port is opened, so nothing but
   this process can drive the browser. The whole session has one deadline: past it, every pending call is refused and
   Chromium is killed. */

import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export type CdpParams = Record<string, unknown>
export type CdpHandler = (params: CdpParams, sessionId?: string) => void

export interface CdpClient {
  send<T = CdpParams>(method: string, params?: CdpParams, sessionId?: string): Promise<T>
  on(event: string, handler: CdpHandler): void
  /** Asks the browser to close, then kills it; resolves once the process is gone. */
  close(): Promise<void>
  /** True once the deadline passed. */
  readonly timedOut: boolean
}

export interface LaunchOptions {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpError'
  }
}

interface Pending {
  resolve: (value: CdpParams) => void
  reject: (err: Error) => void
  method: string
}

export function launchChromium(opts: LaunchOptions): CdpClient {
  const proc = spawn(opts.binary, opts.args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env: opts.env })
  const toChrome = proc.stdio[3] as Writable
  const fromChrome = proc.stdio[4] as Readable
  const pending = new Map<number, Pending>()
  const handlers = new Map<string, Set<CdpHandler>>()
  let nextId = 0
  let buffer = Buffer.alloc(0)
  let failure: Error | null = null
  let timedOut = false
  let stderrTail = ''

  const exited = new Promise<void>((done) => {
    proc.on('exit', () => done())
    proc.on('error', () => done())
  })
  const fail = (err: Error) => {
    if (failure) return
    failure = err
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  proc.stdout?.on('data', () => undefined) // drained
  proc.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString('utf-8')).slice(-1000)
  })
  proc.on('error', (err) => fail(new CdpError(`chromium could not start: ${err.message}`)))
  proc.on('exit', (code, signal) => fail(new CdpError(`chromium exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`)))
  toChrome.on('error', (err) => fail(new CdpError(`chromium pipe: ${err.message}`)))

  fromChrome.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    let end: number
    while ((end = buffer.indexOf(0)) >= 0) {
      const text = buffer.subarray(0, end).toString('utf-8')
      buffer = buffer.subarray(end + 1)
      let msg: { id?: number; method?: string; params?: CdpParams; result?: CdpParams; error?: { message?: string }; sessionId?: string }
      try {
        msg = JSON.parse(text)
      } catch {
        continue
      }
      if (typeof msg.id === 'number') {
        const call = pending.get(msg.id)
        if (!call) continue
        pending.delete(msg.id)
        if (msg.error) call.reject(new CdpError(`${call.method}: ${msg.error.message ?? 'failed'}`))
        else call.resolve(msg.result ?? {})
      } else if (msg.method) {
        for (const h of handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId)
      }
    }
  })

  const timer = setTimeout(() => {
    timedOut = true
    fail(new CdpError(`chromium stopped after ${opts.timeoutMs / 1000} s`))
    proc.kill('SIGKILL')
  }, opts.timeoutMs)

  return {
    get timedOut() {
      return timedOut
    },
    send<T = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
      if (failure) return Promise.reject(failure)
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: CdpParams) => void, reject, method })
        toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
      })
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set<CdpHandler>()
      set.add(handler)
      handlers.set(event, set)
    },
    async close() {
      clearTimeout(timer)
      if (!failure) {
        const closing = this.send('Browser.close').catch(() => undefined)
        await Promise.race([closing, new Promise((r) => setTimeout(r, 1000))])
      }
      fail(new CdpError('chromium closed'))
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      await exited
    },
  }
}
