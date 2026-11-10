/* Typed values for every request and every engine (regression).

   Before: a request that carried its own source declared its fields, but only `sections` and `contact` were checked.
   A number, a boolean, a list or an object sent for a `string` field reached the engine as it was: Typst got a number,
   array or dictionary literal where the template expected text, and the HTML engines a JSON dump. Now every value is
   checked by its field's type when the request is resolved (400) and again by the orchestrator before any engine
   runs, whatever the format; a value no field declares must be text, a number or true/false. */

import { BadRequestException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { renderInputSchema, type OutputType, type RenderFormat, type RenderRequest } from '../src/contracts/index.js'
import type { EngineRenderRequest, RenderEngine } from '../src/contracts/engine.js'
import type { Env } from '../src/config/env.js'
import { DataValidatorService } from '../src/render/data-validator.service.js'
import { JSON_LIMITS, parseRequestValues, parseTemplateValues } from '../src/render/document-fields.js'
import { OrchestratorService } from '../src/render/orchestrator.service.js'
import { TemplateRegistryService } from '../src/render/template-registry.service.js'
import { composeSource } from '../src/render/engines/typst.engine.js'

const FORMATS: Array<[RenderFormat, OutputType]> = [
  ['typst', 'pdf'],
  ['markdown', 'pdf'],
  ['quarto', 'pdf'],
  ['html', 'pdf'],
  ['mjml', 'html'],
]
const NOT_TEXT: unknown[] = [42, true, ['x'], { 'x: read("/etc/passwd"), y': 1 }, { a: { b: 1 } }]
const TITLE = { key: 'title', label: 'Title', fieldTypeKey: 'string' }

function refusal(run: () => unknown): { error: string; issues: Array<{ path: unknown[] }> } | null {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException)
    return (e as BadRequestException).getResponse() as { error: string; issues: Array<{ path: unknown[] }> }
  }
  return null
}

describe('a request with its own source', () => {
  const registry = new TemplateRegistryService()
  const resolve = (format: RenderFormat, values: Record<string, unknown>, fields: unknown[] = [TITLE]) =>
    refusal(() => registry.resolve(renderInputSchema.parse({ format, source: 'x', fields, values })))

  it.each(FORMATS)('%s: refuses a number, a boolean, a list or an object in a string field, naming it', (format) => {
    for (const bad of NOT_TEXT) {
      expect(resolve(format, { title: bad }), JSON.stringify(bad)).toMatchObject({ error: 'validation_failed', issues: [{ path: ['title'] }] })
    }
    expect(resolve(format, { title: 'A title' })).toBeNull()
  })

  it('takes a type it does not know as text', () => {
    const field = { key: 'note', label: 'Note', fieldTypeKey: 'rich_text' }
    expect(resolve('typst', { note: { a: 1 } }, [field])?.issues[0].path).toEqual(['note'])
    expect(resolve('typst', { note: 'ok' }, [field])).toBeNull()
  })

  it('takes a value no field declares only as text, a number or true/false', () => {
    expect(resolve('html', { extra: 'text', n: 1, b: false, gone: null }, [])).toBeNull()
    expect(resolve('html', { extra: { a: 1 } }, [])?.issues[0].path).toEqual(['extra'])
    expect(resolve('mjml', { extra: ['a'] }, [])?.issues[0].path).toEqual(['extra'])
  })

  it('checks every declared type', () => {
    const f = (fieldTypeKey: string, extra: Record<string, unknown> = {}) => [{ key: 'v', label: 'V', fieldTypeKey, ...extra }]
    const ok = (fieldTypeKey: string, v: unknown, extra?: Record<string, unknown>) => parseRequestValues(f(fieldTypeKey, extra) as never, { v }).ok
    expect(ok('number', 1.5)).toBe(true)
    expect(ok('number', '1.5')).toBe(false)
    expect(ok('integer', 3)).toBe(true)
    expect(ok('integer', 3.5)).toBe(false)
    expect(ok('money_cents', 2 ** 60)).toBe(false)
    expect(ok('boolean', false)).toBe(true)
    expect(ok('boolean', 'false')).toBe(false)
    expect(ok('date', '2026-01-31')).toBe(true)
    expect(ok('date', '2026-01-31T09:30:00Z')).toBe(true)
    expect(ok('date', '2026-02-31x')).toBe(false)
    expect(ok('date', 'next tuesday')).toBe(false)
    expect(ok('enum', 'b', { options: ['a', 'b'] })).toBe(true)
    expect(ok('enum', 'c', { options: ['a', 'b'] })).toBe(false)
    expect(ok('array', [1, 'a', { b: [true, null] }])).toBe(true)
    expect(ok('array', { a: 1 })).toBe(false)
    expect(ok('object', { a: [1] })).toBe(true)
    expect(ok('object', ['a'])).toBe(false)
  })

  it('bounds a list or an object: its depth, its size, the text inside', () => {
    let deep: unknown = 'x'
    for (let i = 0; i < JSON_LIMITS.depth + 1; i++) deep = [deep]
    const list = [{ key: 'v', label: 'V', fieldTypeKey: 'array' }] as never
    expect(parseRequestValues(list, { v: deep }).ok).toBe(false)
    expect(parseRequestValues(list, { v: Array.from({ length: JSON_LIMITS.items + 1 }, () => 1) }).ok).toBe(false)
    expect(parseRequestValues(list, { v: ['x'.repeat(JSON_LIMITS.text + 1)] }).ok).toBe(false)
  })
})

describe('a named template', () => {
  const registry = new TemplateRegistryService()

  it('drops a value it does not declare, so only its own fields reach its source', () => {
    const t = registry.list().find((x) => x.id === 'announcement@1')!
    const parsed = parseTemplateValues(t.fields, { heading: 'Hi', body: 'b', smuggled: { a: 1 } })
    expect(parsed.ok && parsed.values).not.toHaveProperty('smuggled')
  })
})

describe('the orchestrator, for any request however it came', () => {
  const config = {
    get: (k: string) => (k === 'FABULA_MAX_CONCURRENT_RENDERS' ? 4 : k === 'FABULA_DRAIN_SECONDS' ? 1 : undefined),
  } as unknown as ConfigService<Env, true>
  const seen: EngineRenderRequest[] = []
  const fake = (format: RenderFormat, outputs: OutputType[]): RenderEngine =>
    ({
      format,
      outputs,
      render: async (req: EngineRenderRequest) => {
        seen.push(req)
        return { ok: true, bytes: new Uint8Array([1]), mime: 'application/octet-stream' }
      },
    }) as RenderEngine
  const orchestrator = new OrchestratorService(
    fake('typst', ['pdf']) as never,
    fake('markdown', ['pdf']) as never,
    fake('quarto', ['pdf']) as never,
    fake('html', ['pdf']) as never,
    fake('mjml', ['html']) as never,
    config,
  )
  const request = (format: RenderFormat, output: OutputType, values: Record<string, unknown>): RenderRequest =>
    ({ format, output, source: 'x', brand: {}, fields: [TITLE], values, engineConfig: {} }) as unknown as RenderRequest

  it.each(FORMATS)('%s: a value that does not fit its type never reaches the engine', async (format, output) => {
    for (const bad of NOT_TEXT) {
      seen.length = 0
      const r = await orchestrator.render(request(format, output, { title: bad }))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.errors[0]).toMatchObject({ file: 'fields' })
      expect(!r.ok && r.errors[0].message).toMatch(/^title: /)
      expect(seen).toHaveLength(0)
    }
    const good = await orchestrator.render(request(format, output, { title: 'A title' }))
    expect(good.ok).toBe(true)
    expect(seen[0].values).toEqual({ title: 'A title' })
  })
})

describe('what Typst receives', () => {
  it('is a string literal for text, whatever the text says', () => {
    const { source } = composeSource('#title', [TITLE as never], { title: '") + read("/etc/passwd") + ("' })
    expect(source.split('\n')[0]).toBe('#let title = "\\") + read(\\"/etc/passwd\\") + (\\""')
  })
})

describe('/data/validate', () => {
  const v = new DataValidatorService()

  it('reads text from CSV as the field’s type, then holds it to the same types a render does', () => {
    const fields = [
      { key: 'n', label: 'N', fieldTypeKey: 'number' },
      { key: 'b', label: 'B', fieldTypeKey: 'boolean' },
      { key: 't', label: 'T', fieldTypeKey: 'string' },
    ] as never
    expect(v.validate({ fields, values: { n: '42', b: 'false', t: 'x' } })).toMatchObject({ ok: true, coercedValues: { n: 42, b: false, t: 'x' } })
    expect(v.validate({ fields, values: { n: 'forty', b: 'no', t: { a: 1 } } }).issues.map((i) => i.path[0])).toEqual(['n', 'b', 't'])
  })
})
