/* What a template source can reach: Quarto's front matter and shortcodes, MJML's includes, WeasyPrint's URL fetcher,
   the inline-source switch and the engine list. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForbiddenException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it } from 'vitest'
import { brandIdentitySchema, renderInputSchema, type RenderRequest } from '../src/contracts/index.js'
import type { EngineRenderRequest, RenderEngine } from '../src/contracts/engine.js'
import { resetSettings, setSettings } from '../src/config/settings.js'
import type { Env } from '../src/config/env.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { MjmlEngine } from '../src/render/engines/mjml.engine.js'
import { quartoSourceProblems } from '../src/render/engines/quarto.engine.js'
import { OrchestratorService } from '../src/render/orchestrator.service.js'
import { TemplateRegistryService } from '../src/render/template-registry.service.js'

afterEach(() => resetSettings())

describe('a Quarto source', () => {
  it('is refused when its front matter loads code or files, at any depth and in any block', () => {
    expect(quartoSourceProblems('---\ntitle: x\nfilters:\n  - _shared/logos/primary-light.svg\n---\nText')).toEqual([
      'front matter `filters` loads code or files and is refused',
    ])
    expect(quartoSourceProblems('---\nformat:\n  typst:\n    include-in-header: /etc/passwd\n---\n')[0]).toContain('format.typst.include-in-header')
    expect(quartoSourceProblems('Text\n\n---\nexecute:\n  enabled: true\n---\n')[0]).toContain('`execute`')
    expect(quartoSourceProblems('---\nengine: knitr\n---\n')).toHaveLength(1)
  })

  it('is refused when it uses a shortcode that reads outside the document', () => {
    expect(quartoSourceProblems('{{< include /proc/1/environ >}}')[0]).toContain('{{< include >}}')
    expect(quartoSourceProblems('{{<embed notebook.ipynb#cell>}}')[0]).toContain('{{< embed >}}')
    expect(quartoSourceProblems('{{< env HOME >}}')).toHaveLength(1)
  })

  it('renders as it is otherwise: a title, a page break, metadata, an escaped shortcode', () => {
    expect(quartoSourceProblems('---\ntitle: "Report"\nformat: typst\nlang: en\n---\n\n# One\n\n{{< pagebreak >}}\n\n{{< meta title >}} {{{< include x >}}}')).toEqual([])
  })
})

describe('an MJML source', () => {
  it('cannot read a server file with <mj-include>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabula-mjml-spec-'))
    const secret = join(dir, 'secret.mjml')
    writeFileSync(secret, '<mj-section><mj-column><mj-text>TOP-SECRET-LINE</mj-text></mj-column></mj-section>')
    const r = await new MjmlEngine(new BrandIdentityService()).render({
      source: `<mjml><mj-body><mj-include path="${secret}" /><mj-section><mj-column><mj-text>hi</mj-text></mj-column></mj-section></mj-body></mjml>`,
      brand: brandIdentitySchema.parse({}),
      fields: [],
      values: {},
      output: 'html',
      engineConfig: {},
    })
    expect(r.ok && Buffer.from(r.bytes).toString('utf-8')).not.toContain('TOP-SECRET-LINE')
  })
})

describe('WeasyPrint’s URL fetcher (scripts/weasyprint-render.py)', () => {
  const python = spawnSync('python3', ['--version'])
  it.skipIf(python.error)('takes data: URLs and files in the render folder, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'fabula-weasy-spec-'))
    mkdirSync(join(root, '_shared'))
    writeFileSync(join(root, '_shared', 'logo.svg'), '<svg/>')
    symlinkSync('/etc/hosts', join(root, 'hosts'))
    const cases: Array<[string, boolean]> = [
      ['data:image/png;base64,AAAA', true],
      [`file://${root}/_shared/logo.svg`, true],
      [`file://${root}/../${root.split('/').pop()}/_shared/logo.svg`, true],
      [`file://${root}/hosts`, false], // a link that leads out
      [`file://${root}/../outside.css`, false],
      ['file:///proc/1/environ', false],
      [`file://${root}`, false],
      ['file://other-host/etc/passwd', false],
      ['https://example.com/x.png', false],
      ['http://127.0.0.1:1/x.css', false],
      ['ftp://example.com/x', false],
    ]
    const script = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(join(process.cwd(), 'scripts', 'weasyprint-render.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      `print(json.dumps([m.allowed(u, ${JSON.stringify(root)}) for u in json.loads(sys.argv[1])]))`,
    ].join('\n')
    const r = spawnSync('python3', ['-I', '-c', script, JSON.stringify(cases.map(([u]) => u))], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual(cases.map(([, ok]) => ok))
  })
})

describe('FABULA_ALLOW_INLINE_SOURCE=false', () => {
  it('refuses a request with its own source (403) and still renders a named template', () => {
    setSettings({ allowInlineSource: false })
    const registry = new TemplateRegistryService()
    expect(() => registry.resolve(renderInputSchema.parse({ format: 'typst', source: '= x' }))).toThrow(ForbiddenException)
    expect(registry.resolve(renderInputSchema.parse({ template: 'checklist@1', values: { title: 'x' } })).ok).toBe(true)
  })
})

describe('FABULA_ENGINES and engineConfig.engine', () => {
  const config = { get: (k: string) => (k === 'FABULA_MAX_CONCURRENT_RENDERS' ? 4 : 1) } as unknown as ConfigService<Env, true>
  const seen: Array<{ name: string; req: EngineRenderRequest }> = []
  const fake = (name: string, format: string, outputs: string[]): RenderEngine =>
    ({
      format,
      outputs,
      render: async (req: EngineRenderRequest) => {
        seen.push({ name, req })
        return { ok: true, bytes: new Uint8Array([1]), mime: 'application/pdf' }
      },
    }) as never
  const build = () =>
    new OrchestratorService(
      fake('typst', 'typst', ['pdf']) as never,
      fake('pandoc', 'markdown', ['pdf']) as never,
      fake('quarto', 'quarto', ['pdf']) as never,
      fake('weasyprint', 'html', ['pdf']) as never,
      fake('mjml', 'mjml', ['html']) as never,
      config,
      undefined,
      fake('chromium', 'html', ['png', 'pdf']) as never,
    )
  const req = (format: string, output: string, engineConfig: Record<string, unknown> = {}) =>
    ({ format, output, source: 'x', brand: {}, fields: [], values: {}, engineConfig }) as unknown as RenderRequest

  it('sends HTML to PDF to WeasyPrint, and to Chromium when asked, without the `engine` key', async () => {
    seen.length = 0
    const o = build()
    await o.render(req('html', 'pdf'))
    await o.render(req('html', 'pdf', { engine: 'chromium', fullPage: false }))
    await o.render(req('html', 'png'))
    expect(seen.map((s) => s.name)).toEqual(['weasyprint', 'chromium', 'chromium'])
    expect(seen[1].req.engineConfig).toEqual({ fullPage: false })
  })

  it('leaves out an engine the list does not name', async () => {
    setSettings({ engines: new Set(['typst', 'mjml']) })
    const o = build()
    expect(o.registeredFormats()).toEqual(['typst', 'mjml'])
    const r = await o.render(req('html', 'pdf'))
    expect(!r.ok && r.errors[0].message).toContain('No engine registered for format="html" output="pdf"')
  })
})
