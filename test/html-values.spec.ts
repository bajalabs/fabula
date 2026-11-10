/* {{ key }} in the HTML and MJML engines (regression).

   Before: a list or an object in a {{ key }} was written into the markup as JSON, a template could name a {{ key }}
   it never declared (filled by any value of the request), and MJML substituted values after the brand's attributes
   were in, so a brand name could be read as a {{ key }}. Now only text, numbers and true/false are substituted, a
   template's every {{ key }} must be one of its fields, and the values go in before the brand. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { BrandAssetsService } from '../src/render/brand/brand-assets.service.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { MjmlEngine } from '../src/render/engines/mjml.engine.js'
import { WeasyPrintEngine } from '../src/render/engines/weasyprint.engine.js'
import { loadTemplates } from '../src/render/template-registry.service.js'
import { substitute, TemplateValueError, tokenKeys } from '../src/util/mustache.js'

const BRAND = brandIdentitySchema.parse({})
const field = (key: string, fieldTypeKey = 'string') => ({ key, label: key, fieldTypeKey, isRequired: false, sortOrder: 0 })

describe('substitute', () => {
  it('writes text, numbers and true/false, escaped', () => {
    expect(substitute('<p>{{ a }} {{ b }} {{ c }} {{ d }}</p>', { a: '<b>"x"</b>', b: 4.5, c: false, d: null })).toBe(
      '<p>&lt;b&gt;&quot;x&quot;&lt;/b&gt; 4.5 false </p>',
    )
  })

  it('refuses a list or an object instead of writing JSON into the markup', () => {
    for (const bad of [['<script>'], { a: '<img src=x>' }]) {
      expect(() => substitute('<p>{{ a }}</p>', { a: bad })).toThrow(TemplateValueError)
    }
  })

  it('names every key a source uses', () => {
    expect([...tokenKeys('{{ a }} {{b}} {{ a }} {{ Not-a-key }}')]).toEqual(['a', 'b'])
  })
})

describe('the engines', () => {
  it('MJML answers a list in a {{ key }} as a field error, and writes nothing', async () => {
    const r = await new MjmlEngine(new BrandIdentityService()).render({
      source: '<mjml><mj-body><mj-section><mj-column><mj-text>{{ items }}</mj-text></mj-column></mj-section></mj-body></mjml>',
      brand: BRAND,
      fields: [field('items', 'array')],
      values: { items: ['<a>', '<b>'] },
      output: 'html',
      engineConfig: {},
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0]).toMatchObject({ file: 'fields' })
    expect(!r.ok && r.errors[0].message).toContain('{{ items }}')
  })

  it('MJML never reads the brand as a {{ key }}', async () => {
    const brand = brandIdentitySchema.parse({ fontBody: '{{ secret }}' })
    const r = await new MjmlEngine(new BrandIdentityService()).render({
      source: '<mjml><mj-head></mj-head><mj-body><mj-section><mj-column><mj-text>hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      brand,
      fields: [field('secret')],
      values: { secret: 'LEAKED' },
      output: 'html',
      engineConfig: {},
    })
    expect(r.ok).toBe(true)
    expect(r.ok && Buffer.from(r.bytes).toString('utf-8')).not.toContain('LEAKED')
  })

  it('WeasyPrint answers a list in a {{ key }} as a field error before anything runs', async () => {
    const assets = new BrandAssetsService({ get: () => [] } as never)
    const r = await new WeasyPrintEngine(new BrandIdentityService(), assets).render({
      source: '<p>{{ rows }}</p>',
      brand: BRAND,
      fields: [field('rows', 'object')],
      values: { rows: { a: 1 } },
      output: 'pdf',
      engineConfig: {},
    })
    expect(!r.ok && r.errors[0]).toMatchObject({ file: 'fields' })
    expect(!r.ok && r.errors[0].message).toContain('{{ rows }}')
  })
})

describe('an HTML or MJML template', () => {
  const make = (format: string, source: string, fields: unknown[]) => {
    const root = mkdtempSync(join(tmpdir(), 'fabula-html-values-spec-'))
    mkdirSync(join(root, 'doc', 'note', 'v1'), { recursive: true })
    const entry = format === 'mjml' ? 'main.mjml' : 'main.html'
    writeFileSync(join(root, 'doc', 'note', 'v1', 'template.json'), JSON.stringify({ name: 'note', kind: 'doc', version: 1, title: 'Note', format, entry, output: format === 'mjml' ? 'html' : 'pdf', fields }))
    writeFileSync(join(root, 'doc', 'note', 'v1', entry), source)
    return root
  }

  it('stops the load when it names a {{ key }} it does not declare', () => {
    expect(() => loadTemplates(make('html', '<p>{{ title }} {{ other }}</p>', [field('title')]))).toThrow(/\{\{ other \}\} is not a declared field/)
    expect(() => loadTemplates(make('mjml', '<mjml>{{ x }}</mjml>', []))).toThrow(/\{\{ x \}\}/)
    expect([...loadTemplates(make('html', '<p>{{ title }}</p>', [field('title')])).keys()]).toEqual(['note@1'])
  })
})
