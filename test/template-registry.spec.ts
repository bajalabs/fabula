/* Templates by name: the repository's templates load and resolve; a broken template folder stops the load with its
   path; a request carries a template or a source, never both. */


import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { renderInputSchema } from '../src/contracts/index.js'
import { readPdfOptions } from '../src/contracts/pdf-options.js'
import { TemplateRegistryService, loadTemplates } from '../src/render/template-registry.service.js'

const BRAND = { brandName: 'B', displayName: 'Acme',
  primaryColor: '#0E7C66', secondaryColor: '#C5973B', fontBody: 'Noto Sans', fontHeading: 'Noto Serif',
}

describe('the repository’s templates', () => {
  const registry = new TemplateRegistryService()

  it('loads every template, sorted by name', () => {
    expect(registry.list().map((t) => t.id)).toEqual(['announcement@1', 'brief@1', 'certificate@1', 'checklist@1', 'memo@1', 'one-pager@1', 'social-card@1'])
    const checklist = registry.list().find((t) => t.id === 'checklist@1')!
    expect(checklist).toMatchObject({ kind: 'document', format: 'typst', output: 'pdf' })
    expect(checklist.fields.map((f) => f.key)).toEqual(['title', 'subtitle', 'sections', 'contact', 'web', 'lang'])
  })

  it('has an example for every engine, each with a sample that fits its own fields', () => {
    const route = (t: { format: string; output: string }) =>
      ({ typst: 'typst', markdown: 'pandoc', quarto: 'quarto', mjml: 'mjml' })[t.format] ?? (t.output === 'pdf' ? 'weasyprint' : 'chromium')
    expect([...new Set(registry.list().map(route))].sort()).toEqual(['chromium', 'mjml', 'pandoc', 'quarto', 'typst', 'weasyprint'])
    for (const t of registry.list()) {
      const r = registry.resolve(renderInputSchema.parse({ template: t.id, values: t.sample }))
      expect(r.ok, t.id).toBe(true)
      expect(Object.keys(t.sample).every((k) => t.fields.some((f) => f.key === k)), t.id).toBe(true)
    }
  })

  it('imports _shared/brand.typ in every Markdown or Quarto template that uses a brand name in its Typst', () => {
    // A Typst template imports it at its top; Pandoc's and Quarto's raw Typst must import it too, or the PDF fails
    // with "unknown variable" (found by the image's smoke test, which renders every sample)
    const brandName = /#[^\n]*\b(?:brand-[a-z-]+|font-(?:body|heading|mono)|company)\b/
    const markdown = registry.list().filter((t) => t.format === 'markdown' || t.format === 'quarto')
    expect(markdown.map((t) => t.id).sort()).toEqual(['brief@1', 'memo@1'])
    for (const t of markdown) {
      const r = registry.resolve(renderInputSchema.parse({ template: t.id, values: t.sample }))
      if (!r.ok) throw new Error(t.id)
      if (brandName.test(r.request.source)) expect(r.request.source, t.id).toContain('#import "/_shared/brand.typ": *')
    }
  })

  it('selects a version only by its exact name: there is no latest', () => {
    const one = registry.resolve(renderInputSchema.parse({ template: 'one-pager@1', brand: BRAND }))
    expect(one.ok && one.request.meta?.templateVersion).toBe(1)
    expect(registry.resolve(renderInputSchema.parse({ template: 'one-pager@9', brand: BRAND })).ok).toBe(false)
    expect(renderInputSchema.safeParse({ template: 'one-pager', brand: BRAND }).success).toBe(false)
    expect(renderInputSchema.safeParse({ template: 'one-pager@latest', brand: BRAND }).success).toBe(false)
  })

  it('resolves a template into an ordinary request, the request’s engineConfig over the template’s', () => {
    const input = renderInputSchema.parse({ template: 'checklist@1', brand: BRAND, values: { title: 'x', subtitle: 'a' }, engineConfig: { pdf: { standards: ['a-2b'] } } })
    const r = registry.resolve(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.request).toMatchObject({ format: 'typst', output: 'pdf', values: { title: 'x', subtitle: 'a' }, meta: { templateId: 'checklist', templateVersion: 1 } })
    expect(r.request.source).toContain('#import "_shared/brand.typ": *')
    expect(r.request.fields.map((f) => f.key)).toContain('sections')
    expect(r.request.engineConfig).toEqual({ pdf: { standards: ['ua-1', 'a-2b'] } })
  })

  it('never lets a request switch a template’s accessibility off', () => {
    const asked = (pdf: unknown) => {
      const r = registry.resolve(renderInputSchema.parse({ template: 'one-pager@1', brand: BRAND, engineConfig: { pdf } }))
      return r.ok ? r.request.engineConfig.pdf : null
    }
    expect(asked({ standards: [] })).toEqual({ standards: ['ua-1'] })
    expect(asked({})).toEqual({ standards: ['ua-1'] })
    expect(asked(null)).toEqual({ standards: ['ua-1'] })
    expect(asked({ standards: null })).toEqual({ standards: ['ua-1'] })
    // tagged: false stays in, and readPdfOptions refuses it beside ua-1
    const off = asked({ tagged: false }) as Record<string, unknown>
    expect(readPdfOptions({ pdf: off }).ok).toBe(false)
  })

  it('warns when the brand has no file for the logo the head draws, and only then', () => {
    const logo = (variant: string, mode: string) => ({ variant, mode, format: 'svg', url: 'https://files.example.com/l.svg', sha256: 'a'.repeat(64) })
    const warnings = (id: string, logos: unknown[]) => {
      const r = registry.resolve(renderInputSchema.parse({ template: id, brand: { ...BRAND, logos } }))
      return r.ok ? r.warnings.map((w) => w.message) : null
    }
    expect(warnings('one-pager@1', [])?.[0]).toContain('no stacked or primary logo with mode dark')
    expect(warnings('one-pager@1', [logo('primary', 'light')])).toHaveLength(1)
    expect(warnings('one-pager@1', [logo('primary', 'dark')])).toEqual([])
    expect(warnings('checklist@1', [logo('stacked', 'light')])).toEqual([])
    expect(warnings('checklist@1', [logo('mark', 'light')])?.[0]).toContain('mode light')
  })

  it('keeps the template’s engineConfig and output when the request names none', () => {
    const r = registry.resolve(renderInputSchema.parse({ template: 'announcement@1', brand: BRAND }))
    expect(r.ok && r.request.output).toBe('html')
    const c = registry.resolve(renderInputSchema.parse({ template: 'checklist@1', brand: BRAND }))
    expect(c.ok && c.request.engineConfig).toEqual({ pdf: { standards: ['ua-1'] } })
  })

  it('passes a source request through as it was', () => {
    const r = registry.resolve(renderInputSchema.parse({ format: 'typst', source: '= Hello', brand: BRAND }))
    expect(r.ok && r.request).toMatchObject({ format: 'typst', source: '= Hello', output: 'pdf' })
  })

  it('answers an unknown template with an error naming template', () => {
    const r = registry.resolve(renderInputSchema.parse({ template: 'nope@9', brand: BRAND }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ file: 'template', message: 'no template nope@9' })
  })
})

describe('a template’s values', () => {
  const registry = new TemplateRegistryService()
  const refused = (template: string, values: Record<string, unknown>) => {
    try {
      registry.resolve(renderInputSchema.parse({ template, brand: BRAND, values }))
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException)
      expect((e as BadRequestException).getStatus()).toBe(400)
      return ((e as BadRequestException).getResponse() as { error: string; issues: Array<{ path: unknown[] }> })
    }
    return null
  }

  it('answers 400 naming the field for a non-string in every string field of every template', () => {
    const strings = registry.list().flatMap((t) => t.fields.filter((f) => f.fieldTypeKey === 'string').map((f) => [t.id, f.key] as const))
    expect(strings.length).toBeGreaterThan(10)
    for (const [id, key] of strings) {
      for (const bad of [{ 'x: read("/etc/passwd"), y': 1 }, 1, true, ['x']]) {
        const r = refused(id, { [key]: bad })
        expect(r, `${id} ${key}`).toMatchObject({ error: 'validation_failed', issues: [{ path: [key] }] })
      }
    }
  })

  it('refuses the example that compiled as code', () => {
    expect(refused('one-pager@1', { title: { 'x: read("/etc/passwd"), y': 1 } })?.issues[0].path).toEqual(['title'])
  })

  it('limits every plain field, and takes the limit itself', () => {
    expect(refused('one-pager@1', { title: 'x'.repeat(301) })?.issues[0].path).toEqual(['title'])
    expect(refused('one-pager@1', { title: 'x'.repeat(300) })).toBeNull()
    expect(refused('one-pager@1', { intro: 'x'.repeat(2001) })?.issues[0].path).toEqual(['intro'])
    expect(refused('announcement@1', { body: 'x'.repeat(10_001) })?.issues[0].path).toEqual(['body'])
  })

  it('holds lang to two letters and a link to https', () => {
    expect(refused('checklist@1', { lang: 'english' })?.issues[0].path).toEqual(['lang'])
    expect(refused('announcement@1', { cta_url: 'javascript:alert(1)' })?.issues[0].path).toEqual(['cta_url'])
    expect(refused('announcement@1', { cta_url: '' })).toBeNull()
  })

  it('answers 400 for a wrong section too', () => {
    expect(refused('one-pager@1', { sections: [{ kind: 'text' }] })?.issues[0].path).toEqual(['sections', 0, 'body'])
  })

  it('takes a null as no value, so the default applies', () => {
    const r = registry.resolve(renderInputSchema.parse({ template: 'one-pager@1', brand: BRAND, values: { title: null, sections: null, contact: null } }))
    if (!r.ok) throw new Error('resolve')
    for (const key of ['title', 'sections', 'contact']) expect(r.request.values).not.toHaveProperty(key)
  })
})

describe('renderInputSchema', () => {
  it('refuses a template with a source, and a request with neither', () => {
    expect(renderInputSchema.safeParse({ template: 'checklist@1', source: 'x', format: 'typst', brand: BRAND }).success).toBe(false)
    expect(renderInputSchema.safeParse({ brand: BRAND }).success).toBe(false)
    expect(renderInputSchema.safeParse({ template: 'Checklist', brand: BRAND }).success).toBe(false)
  })
})

describe('loadTemplates', () => {
  const make = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'fabula-templates-spec-'))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    return root
  }
  const manifest = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ name: 'note', kind: 'doc', version: 1, title: 'Note', format: 'typst', entry: 'main.typ', ...over })

  it('loads a good folder', () => {
    const root = make({ 'doc/note/v1/template.json': manifest(), 'doc/note/v1/main.typ': '= Note' })
    expect([...loadTemplates(root).keys()]).toEqual(['note@1'])
  })

  it('stops on a field with no schema, so no template can go unchecked', () => {
    const fields = [{ key: 'rows', label: 'Rows', fieldTypeKey: 'spreadsheet' }]
    expect(() => loadTemplates(make({ 'doc/note/v1/template.json': manifest({ fields }), 'doc/note/v1/main.typ': '' }))).toThrow(/field rows \(spreadsheet\) has no schema/)
  })

  it('stops on a folder that does not match its manifest, a missing entry, bad JSON or a bad version folder', () => {
    expect(() => loadTemplates(make({ 'doc/note/v1/template.json': manifest({ version: 2 }), 'doc/note/v1/main.typ': '' }))).toThrow(/templates\/doc\/note\/v1/)
    expect(() => loadTemplates(make({ 'doc/note/v1/template.json': manifest() }))).toThrow(/entry main.typ is missing/)
    expect(() => loadTemplates(make({ 'doc/note/v1/template.json': '{', 'doc/note/v1/main.typ': '' }))).toThrow(/not JSON/)
    expect(() => loadTemplates(make({ 'doc/note/latest/template.json': manifest(), 'doc/note/latest/main.typ': '' }))).toThrow(/v<number>/)
  })
})
