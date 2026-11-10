/* TemplateRegistryService: templates by name.

   templates/<kind>/<name>/v<version>/template.json + its entry file, under FABULA_TEMPLATES_DIR (./templates by
   default). Read once at boot and checked: a manifest that does not parse, a folder that does not match its manifest,
   a missing entry or two templates with one id stop the boot with the path named, so a broken template never waits
   for its first caller.

   A request calls one as `<name>@<version>`; it becomes an ordinary render request: the template's format, source and
   fields, its default output when the request names none, and its engineConfig under the request's own. A request
   may carry its own source instead, unless FABULA_ALLOW_INLINE_SOURCE=false (403).

   Every field of a template has a schema (document-fields.ts): a template that declares one without is a boot error,
   and a value that does not fit is a 400 naming the field, before any engine runs. A template's PDF standards are a
   floor: a request can add to them, never take them away. */

import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderRequestSchema,
  templateManifestSchema,
  type CompileError,
  type RenderInput,
  type RenderRequest,
  type TemplateManifest,
} from '../contracts/index.js'

import { brandPrimaryLogoMode } from './brand/brand-identity.service.js'
import { fieldSchema, parseRequestValues, parseTemplateValues, type FieldIssue } from './document-fields.js'
import { tokenKeys } from '../util/mustache.js'
import { settings } from '../config/settings.js'

export interface LoadedTemplate {
  id: string
  manifest: TemplateManifest
  source: string
}

export type TemplateResolution =
  | { ok: true; request: RenderRequest; warnings: CompileError[] }
  | { ok: false; errors: CompileError[] }

/** The request's engineConfig over the template's; a template's PDF standards stay, whatever the request says. */
function mergeEngineConfig(template: Record<string, unknown>, asked: Record<string, unknown> = {}): Record<string, unknown> {
  const floor = (template.pdf as { standards?: unknown } | undefined)?.standards
  const { pdf, ...rest } = asked
  // A null is no value, here as in a field: it must not take the template's pdf away
  if (pdf === null || pdf === undefined) return { ...template, ...rest }
  if (!Array.isArray(floor) || typeof pdf !== 'object') return { ...template, ...asked }
  const standards = (pdf as { standards?: unknown }).standards ?? []
  // Anything but a list is left for readPdfOptions to refuse
  return { ...template, ...rest, pdf: { ...pdf, standards: Array.isArray(standards) ? [...new Set([...floor, ...standards])] : standards } }
}

/** A warning when the brand has no file for the logo the template's head draws: the render goes on, and says so. */
function logoWarnings(id: string, where: TemplateManifest['headLogo'], brand: RenderRequest['brand']): CompileError[] {
  if (!where) return []
  const mode = where === 'band' ? brandPrimaryLogoMode(brand) : 'light'
  const found = (brand.logos ?? []).some((l) => l.mode === mode && (l.variant === 'stacked' || l.variant === 'primary'))
  if (found) return []
  return [{ severity: 'warning', file: 'brand', message: `${id}: the brand has no stacked or primary logo with mode ${mode}, so the head has no logo` }]
}

const invalid = (issues: FieldIssue[]) => new BadRequestException({ error: 'validation_failed', issues })

const dirs = (p: string): string[] =>
  existsSync(p) ? readdirSync(p).filter((d) => !d.startsWith('.') && statSync(join(p, d)).isDirectory()).sort() : []

/** Every template under `root`, checked; throws naming the first path that is wrong. */
export function loadTemplates(root: string): Map<string, LoadedTemplate> {
  const out = new Map<string, LoadedTemplate>()
  for (const kind of dirs(root)) {
    for (const name of dirs(join(root, kind))) {
      for (const v of dirs(join(root, kind, name))) {
        const where = `templates/${kind}/${name}/${v}`
        const m = v.match(/^v([1-9][0-9]{0,3})$/)
        if (!m) throw new Error(`${where}: a version folder is named v<number>`)
        const file = join(root, kind, name, v, 'template.json')
        if (!existsSync(file)) throw new Error(`${where}: no template.json`)
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(file, 'utf-8'))
        } catch (e) {
          throw new Error(`${where}/template.json is not JSON: ${e instanceof Error ? e.message : e}`, { cause: e })
        }
        const parsed = templateManifestSchema.safeParse(raw)
        if (!parsed.success) {
          throw new Error(`${where}/template.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        }
        const manifest = parsed.data
        if (manifest.kind !== kind || manifest.name !== name || manifest.version !== Number(m[1])) {
          throw new Error(`${where}: the manifest says ${manifest.kind}/${manifest.name} v${manifest.version}`)
        }
        const entry = join(root, kind, name, v, manifest.entry)
        if (!existsSync(entry)) throw new Error(`${where}: entry ${manifest.entry} is missing`)
        const id = `${name}@${manifest.version}`
        for (const field of manifest.fields) {
          if (!fieldSchema(field)) throw new Error(`${where}: field ${field.key} (${field.fieldTypeKey}) has no schema`)
        }
        const source = readFileSync(entry, 'utf-8')
        if (manifest.format === 'html' || manifest.format === 'mjml') {
          // A {{ key }} the template does not declare would be filled by a value whose type nothing checked
          const declared = new Set(manifest.fields.map((f) => f.key))
          const undeclared = [...tokenKeys(source)].filter((k) => !declared.has(k))
          if (undeclared.length) throw new Error(`${where}: {{ ${undeclared.join(' }}, {{ ')} }} is not a declared field`)
        }
        if (out.has(id)) throw new Error(`${where}: ${id} is defined twice`)
        out.set(id, { id, manifest, source })
      }
    }
  }
  return out
}

@Injectable()
export class TemplateRegistryService {
  private readonly log = new Logger('TemplateRegistry')
  private readonly templates: Map<string, LoadedTemplate>

  constructor() {
    this.templates = loadTemplates(settings().templatesDir)
    this.log.log(`${this.templates.size} templates: ${[...this.templates.keys()].join(', ') || 'none'}`)
  }

  /** Every template, newest version first within a name. */
  list() {
    return [...this.templates.values()]
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || b.manifest.version - a.manifest.version)
      .map(({ id, manifest: m }) => ({
        id, name: m.name, kind: m.kind, version: m.version, title: m.title, description: m.description,
        format: m.format, output: m.output, fields: m.fields, sample: m.sample,
      }))
  }

  /** A render input as an ordinary render request: a source as it came, a template by its manifest. */
  resolve(input: RenderInput): TemplateResolution {
    if (!input.template) {
      if (!settings().allowInlineSource) {
        throw new ForbiddenException({ error: 'inline_source_disabled', message: 'this instance renders named templates only (FABULA_ALLOW_INLINE_SOURCE=false)' })
      }
      // A source of the caller's own: its declared fields by their types, any other value as plain text
      const request = renderRequestSchema.parse(input)
      const parsed = parseRequestValues(request.fields, request.values)
      if (!parsed.ok) throw invalid(parsed.issues)
      return { ok: true, request: { ...request, values: parsed.values }, warnings: [] }
    }
    const t = this.templates.get(input.template)
    if (!t) {
      return { ok: false, errors: [{ severity: 'error', message: `no template ${input.template}`, file: 'template' }] }
    }
    const parsed = parseTemplateValues(t.manifest.fields, input.values ?? {})
    if (!parsed.ok) throw invalid(parsed.issues)
    const { template: _drop, ...rest } = input
    const request = renderRequestSchema.parse({
      ...rest,
      values: parsed.values,
      format: t.manifest.format,
      source: t.source,
      output: input.output ?? t.manifest.output,
      fields: t.manifest.fields,
      engineConfig: mergeEngineConfig(t.manifest.engineConfig, input.engineConfig),
      meta: { ...(input.meta ?? {}), templateId: t.manifest.name, templateVersion: t.manifest.version },
    })
    return { ok: true, request, warnings: logoWarnings(t.id, t.manifest.headLogo, request.brand) }
  }
}
