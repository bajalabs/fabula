/* Field values: every template field has a schema, and a value that does not fit never reaches an engine.

   A plain field is a string of a limited length; `lang` is two letters and a `*_url` field https. `sections` and
   `contact` are the typed fields of one-pager@1 and checklist@1. A template that declares any other field is a boot
   error, so none can go unchecked.

   parseTemplateValues (TemplateRegistryService) checks every field of a template by name. parseDocumentValues
   (TypstEngine) checks the typed fields of any request and fills their defaults, so the Typst can read every key. A
   null value counts as no value: the field's default applies. documentImages finds the pictures in the parsed
   sections, for BrandAssetsService to fetch; `place` swaps a picture's reference for its file in the work directory,
   so the URL never reaches Typst. */

import { z } from 'zod'
import {
  DOCUMENT_LIMITS,
  documentContactSchema,
  documentSectionsSchema,
  type CompileError,
  type TemplateField,
} from '../contracts/index.js'
import type { ImageRequest } from './brand/brand-assets.service.js'

type Sections = z.output<typeof documentSectionsSchema>

/** Characters in a plain field, by its key; a field not named here is one line. */
export const PLAIN_FIELD_LIMITS = { line: 300, intro: 2000, notes: 2000, footer: 2000, body: 10_000, url: 2048 } as const

const TYPED: Record<string, z.ZodType> = { sections: documentSectionsSchema, contact: documentContactSchema }

function plainSchema(key: string): z.ZodType {
  if (key === 'lang') return z.string().regex(/^[a-z]{2}$/, 'lang must be two lower-case letters')
  if (key.endsWith('_url')) {
    return z.union([z.literal(''), z.url({ protocol: /^https$/, error: `${key} must be https` }).max(PLAIN_FIELD_LIMITS.url)])
  }
  const limits: Record<string, number> = PLAIN_FIELD_LIMITS
  return z.string().max(limits[key] ?? PLAIN_FIELD_LIMITS.line)
}

/** The schema of a template's field; null when the template declares one Fabula cannot check. */
export function fieldSchema(_templateId: string, field: TemplateField): z.ZodType | null {
  if (field.fieldTypeKey === 'string') return plainSchema(field.key)
  return TYPED[field.fieldTypeKey] ?? null
}

export interface FieldIssue {
  path: Array<string | number>
  message: string
  code: string
}

type ParsedValues = { ok: true; values: Record<string, unknown> } | { ok: false; issues: FieldIssue[] }

export type DocumentValues =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: CompileError[] }

export interface DocumentImage extends ImageRequest {
  /** Called with the placed file's path. */
  place(path: string): void
}

function parseFields(
  fields: readonly TemplateField[],
  values: Record<string, unknown>,
  schemaOf: (field: TemplateField) => z.ZodType | null | undefined,
): ParsedValues {
  const out = { ...values }
  const issues: FieldIssue[] = []
  for (const field of fields) {
    const schema = schemaOf(field)
    if (!schema) continue
    const raw = Object.prototype.hasOwnProperty.call(values, field.key) ? values[field.key] : field.defaultValue
    if (raw === undefined || raw === null) {
      delete out[field.key]
      continue
    }
    const parsed = schema.safeParse(raw)
    if (parsed.success) out[field.key] = parsed.data
    else issues.push(...parsed.error.issues.map((i) => ({ path: [field.key, ...i.path.map((p) => p as string | number)], message: i.message, code: i.code })))
  }
  if (issues.length === 0) {
    const count = documentImages(fields, out).length
    if (count > DOCUMENT_LIMITS.images) {
      issues.push({ path: ['sections'], message: `at most ${DOCUMENT_LIMITS.images} images in a document, not ${count}`, code: 'too_big' })
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, values: out }
}

/** Every field of a template by name. */
export function parseTemplateValues(templateId: string, fields: readonly TemplateField[], values: Record<string, unknown>): ParsedValues {
  return parseFields(fields, values, (field) => fieldSchema(templateId, field))
}

/** The typed fields of any request; a template's values were checked by name before they got here. */
export function parseDocumentValues(fields: readonly TemplateField[], values: Record<string, unknown>): DocumentValues {
  const parsed = parseFields(fields, values, (field) => TYPED[field.fieldTypeKey])
  if (parsed.ok) return parsed
  return {
    ok: false,
    errors: parsed.issues.map((i) => ({ severity: 'error', message: `${i.path.join('.')}: ${i.message}`, file: 'fields' })),
  }
}

/** Every card picture in parsed values, in reading order. */
export function documentImages(fields: readonly TemplateField[], values: Record<string, unknown>): DocumentImage[] {
  const found: DocumentImage[] = []
  const walk = (sections: Sections, where: string) => {
    sections.forEach((section, n) => {
      const at = `${where}.${n}`
      if (section.kind === 'row') {
        walk(section.left, `${at}.left`)
        walk(section.right, `${at}.right`)
      } else if (section.kind === 'cards') {
        section.items.forEach((item, i) => {
          const image = item.image
          if (!image) return
          found.push({
            url: image.url,
            sha256: image.sha256,
            where: `${at}.items.${i}`,
            place: (path) => {
              ;(item as { image?: unknown }).image = { path, alt: image.alt }
            },
          })
        })
      }
    })
  }
  for (const field of fields) {
    if (field.fieldTypeKey === 'sections' && Array.isArray(values[field.key])) walk(values[field.key] as Sections, field.key)
  }
  return found
}
