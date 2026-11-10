#!/usr/bin/env node
// A small client for a running Fabula: it signs each request and prints the answer, or writes the document.
//
//   node scripts/fabula.mjs health
//   node scripts/fabula.mjs templates
//   node scripts/fabula.mjs render <name@version> [values.json] [--output pdf|png|jpeg|html|docx|pptx] [--out file]
//   node scripts/fabula.mjs request <METHOD> <path> [body.json]
//   node scripts/fabula.mjs smoke
//
// render takes the template's own sample when no values file is given. smoke renders every template's sample and
// checks what comes back (the CI image job runs it), then checks that an unsigned request and a value of the wrong
// type are refused.
//
// Environment: FABULA_URL (default http://localhost:3100), FABULA_CALLER (default "me") with FABULA_KEY (the
// caller's hex key) for a signed request, or FABULA_TOKEN for FABULA_AUTH=token. Node 24, no dependency.

import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = (process.env.FABULA_URL ?? 'http://localhost:3100').replace(/\/+$/, '')
const CALLER = process.env.FABULA_CALLER ?? 'me'
const KEY = process.env.FABULA_KEY
const TOKEN = process.env.FABULA_TOKEN

/** The headers of a signed request: HMAC-SHA256 over `${caller}.${t}.${METHOD}.${pathWithQuery}.${body}`. */
export function signature(method, path, body, key = KEY, caller = CALLER, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', Buffer.from(key, 'hex')).update(`${caller}.${t}.${method.toUpperCase()}.${path}.`).update(body).digest('hex')
  return { 'x-fabula-caller': caller, 'x-fabula-signature': `t=${t},v1=${v1}` }
}

async function call(method, path, payload, { sign = true } = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const headers = body ? { 'content-type': 'application/json' } : {}
  if (sign && TOKEN) headers.authorization = `Bearer ${TOKEN}`
  else if (sign && KEY) Object.assign(headers, signature(method, path, body))
  const res = await fetch(BASE + path, { method, headers, body: body || undefined })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

const MAGIC = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'text/html; charset=utf-8': (b) => /<html|<table|<!doctype/i.test(b.toString('utf-8', 0, 4096)),
}

async function render(template, values, output) {
  return call('POST', '/render', { template, values, ...(output ? { output } : {}), meta: { requestId: `${template}-${Date.now()}` } })
}

async function sampleOf(id) {
  const list = await call('GET', '/templates')
  if (list.status !== 200) throw new Error(`GET /templates answered ${list.status}: ${JSON.stringify(list.json)}`)
  const t = list.json.templates.find((x) => x.id === id)
  if (!t) throw new Error(`no template ${id}; these exist: ${list.json.templates.map((x) => x.id).join(', ')}`)
  return t.sample
}

async function smoke() {
  let failed = 0
  const check = (ok, line) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
    if (!ok) failed++
  }
  const list = await call('GET', '/templates')
  check(list.status === 200, `GET /templates → ${list.status}`)
  for (const t of list.json.templates ?? []) {
    const r = await render(t.id, t.sample)
    const bytes = r.json.bytes ? Buffer.from(r.json.bytes, 'base64') : Buffer.alloc(0)
    const good = r.status === 200 && r.json.ok === true && MAGIC[r.json.mime]?.(bytes) === true
    check(good, `${t.id} (${t.format} → ${t.output}) → ${r.status} ${r.json.mime ?? ''} ${bytes.length} bytes${good ? '' : ` ${JSON.stringify(r.json.errors ?? r.json).slice(0, 400)}`}`)
  }
  const unsigned = await call('POST', '/render', { template: 'checklist@1', values: { title: 'x' } }, { sign: false })
  check(unsigned.status === 401, `unsigned render refused → ${unsigned.status}`)
  const typed = await render('checklist@1', { title: { not: 'text' } })
  check(typed.status === 400 && typed.json.issues?.[0]?.path?.[0] === 'title', `a value of the wrong type refused → ${typed.status}`)
  console.log(failed ? `smoke: ${failed} failed` : 'smoke: every check passed')
  return failed ? 1 : 0
}

async function main(argv) {
  const [command, ...rest] = argv
  const flag = (name) => {
    const i = rest.indexOf(name)
    if (i < 0) return undefined
    const [, v] = rest.splice(i, 2)
    return v
  }
  if (command === 'health') return print(await call('GET', '/health', undefined, { sign: false }))
  if (command === 'templates') return print(await call('GET', '/templates'))
  if (command === 'smoke') return smoke()
  if (command === 'request') {
    const [method, path, file] = rest
    return print(await call(method.toUpperCase(), path, file ? JSON.parse(readFileSync(file, 'utf-8')) : undefined))
  }
  if (command === 'render') {
    const output = flag('--output')
    const out = flag('--out')
    const [id, file] = rest
    if (!id) throw new Error('render <name@version> [values.json]')
    const values = file ? JSON.parse(readFileSync(file, 'utf-8')) : await sampleOf(id)
    const r = await render(id, values, output)
    if (r.status !== 200 || !r.json.ok) return print(r)
    if (out) {
      writeFileSync(out, Buffer.from(r.json.bytes, 'base64'))
      console.log(`${out}: ${r.json.mime}, ${Buffer.from(r.json.bytes, 'base64').length} bytes, ${r.json.durationMs} ms`)
      for (const w of r.json.warnings ?? []) console.log(`warning: ${w.message}`)
      return 0
    }
    return print(r)
  }
  console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  return command ? 2 : 0
}

function print({ status, json }) {
  console.log(JSON.stringify(json, null, 2))
  return status >= 200 && status < 300 ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`fabula: ${err.message}`)
    process.exit(1)
  },
)
