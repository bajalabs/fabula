/* Field values: every value has a type, and a value that does not fit its field never reaches an engine.

   A field's fieldTypeKey says what its value is:

     string             text of a limited length (`lang` is two letters, a `*_url` field https)
     number             a finite number           integer, money_cents   a safe integer
     boolean            true or false             date                   an ISO 8601 date or date-time
     enum               one of the field's `options`
     array, object      JSON lists and objects, at most 32 levels deep
     sections, contact  the typed shapes of the document templates (src/contracts/common.ts)

   Text is escaped by every engine (a Typst string literal, HTML entities); a list or an object reaches Typst as a
   literal whose keys are strings, and never reaches HTML. So a number, a boolean, a list or an object sent where a
   template expects text is refused here, by type, rather than turned into markup.

   parseTemplateValues (TemplateRegistryService) checks a named template's fields; a template that declares a type
   Fabula does not know is a boot error, so none can go unchecked, and only its own fields reach its source.
   parseRequestValues checks a request that carries its own source: a fieldTypeKey Fabula does not know is text, and a
   value no field declares must be text, a number or true/false. The orchestrator checks every request again before
   any engine runs. A null value counts as no value: the field's default applies.

   parseDocumentValues (TypstEngine) fills the defaults of the typed fields, so the Typst can read every key.
   documentImages finds the pictures in the parsed sections, for BrandAssetsService to fetch; `place` swaps a
   picture's reference for its file in the work directory, so the URL never reaches Typst. */

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

/** Characters in a plain field, by its key; a field not named here is one line, unless it sets maxLength. */
export const PLAIN_FIELD_LIMITS = { line: 300, intro: 2000, notes: 2000, footer: 2000, body: 10_000, url: 2048 } as const

/** A value no field declares (a request with its own source): text, a number or true/false, this long at most. */
export const UNDECLARED_TEXT_MAX = 100_000
/** A JSON list or object: how deep, how many items, how long a key or a string inside. */
export const JSON_LIMITS = { depth: 32, items: 1000, key: 256, text: 100_000 } as const

const TYPED: Record<string, z.ZodType> = { sections: documentSectionsSchema, contact: documentContactSchema }

/** The field types Fabula knows; a template may declare only these. */
export const FIELD_TYPES = [
  'string',
  'number',
  'integer',
  'money_cents',
  'boolean',
  'date',
  'enum',
  'array',
  'object',
  'sections',
  'contact',
] as const

function plainSchema(field: Pick<TemplateField, 'key' | 'maxLength'>): z.ZodType {
  const { key } = field
  if (key === 'lang') return z.string().regex(/^[a-z]{2}$/, 'lang must be two lower-case letters')
  if (key.endsWith('_url')) {
    return z.union([z.literal(''), z.url({ protocol: /^https$/, error: `${key} must be https` }).max(PLAIN_FIELD_LIMITS.url)])
  }
  const limits: Record<string, number> = PLAIN_FIELD_LIMITS
  return z.string().max(field.maxLength ?? limits[key] ?? PLAIN_FIELD_LIMITS.line)
}

/** Why `v` is not plain JSON within JSON_LIMITS, or null when it is. */
function jsonProblem(v: unknown, depth: number): string | null {
  if (v === null || typeof v === 'boolean') return null
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'numbers must be finite'
  if (typeof v === 'string') return v.length <= JSON_LIMITS.text ? null : `text inside is at most ${JSON_LIMITS.text} characters`
  if (depth >= JSON_LIMITS.depth) return `nested more than ${JSON_LIMITS.depth} levels`
  if (Array.isArray(v)) {
    if (v.length > JSON_LIMITS.items) return `at most ${JSON_LIMITS.items} items in a list`
    for (const x of v) {
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return null
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length > JSON_LIMITS.items) return `at most ${JSON_LIMITS.items} keys in an object`
    for (const [k, x] of entries) {
      if (k.length > JSON_LIMITS.key) return `keys are at most ${JSON_LIMITS.key} characters`
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return null
  }
  return 'not a JSON value'
}

const jsonOf = <T extends z.ZodType>(base: T) =>
  base.superRefine((v, ctx) => {
    const problem = jsonProblem(v, 0)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

function typedSchema(field: TemplateField): z.ZodType | null {
  switch (field.fieldTypeKey) {
    case 'string':
      return plainSchema(field)
    case 'number':
      return z.number().finite()
    case 'integer':
    case 'money_cents':
      return z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
    case 'boolean':
      return z.boolean()
    case 'date':
      return z
        .string()
        .regex(ISO_DATE, 'must be an ISO 8601 date, like 2026-01-31 or 2026-01-31T09:30:00Z')
        .refine((s) => !Number.isNaN(new Date(s).getTime()), 'is not a real date')
    case 'enum': {
      const options = Array.isArray(field.options) ? field.options.filter((o): o is string => typeof o === 'string') : []
      return options.length ? z.enum(options as [string, ...string[]]) : z.string().max(PLAIN_FIELD_LIMITS.line)
    }
    case 'array':
      return jsonOf(z.array(z.unknown()))
    case 'object':
      return jsonOf(z.record(z.string(), z.unknown()))
    default:
      return TYPED[field.fieldTypeKey] ?? null
  }
}

/** The schema of a template's field; null when the template declares a type Fabula does not know. */
export function fieldSchema(field: TemplateField): z.ZodType | null {
  return typedSchema(field)
}

/** The schema of a field a request declares with its own source: a type Fabula does not know is text. */
export function valueSchema(field: TemplateField): z.ZodType {
  return typedSchema(field) ?? plainSchema(field)
}

const undeclaredSchema = z.union([z.string().max(UNDECLARED_TEXT_MAX), z.number().finite(), z.boolean()], {
  error: 'a value no field declares must be text, a number or true/false; declare a field of type array or object for structured data',
})

export interface FieldIssue {
  path: Array<string | number>
  message: string
  code: string
}

export type ParsedValues = { ok: true; values: Record<string, unknown> } | { ok: false; issues: FieldIssue[] }

export type DocumentValues =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: CompileError[] }

export interface DocumentImage extends ImageRequest {
  /** Called with the placed file's path. */
  place(path: string): void
}

const own = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key)

function parseFields(
  fields: readonly TemplateField[],
  values: Record<string, unknown>,
  schemaOf: (field: TemplateField) => z.ZodType | null | undefined,
  rest: 'keep' | 'drop' | 'check',
): ParsedValues {
  const out: Record<string, unknown> = {}
  const issues: FieldIssue[] = []
  const declared = new Set(fields.map((f) => f.key))
  for (const [key, value] of Object.entries(values)) {
    if (declared.has(key) || rest === 'drop') continue
    if (rest === 'check' && value !== null && value !== undefined) {
      const parsed = undeclaredSchema.safeParse(value)
      if (!parsed.success) {
        issues.push({ path: [key], message: parsed.error.issues[0]?.message ?? 'invalid value', code: 'invalid_type' })
        continue
      }
    }
    if (value !== null && value !== undefined) out[key] = value
  }
  for (const field of fields) {
    const schema = schemaOf(field)
    const raw = own(values, field.key) ? values[field.key] : field.defaultValue
    if (raw === undefined || raw === null) continue
    if (!schema) {
      out[field.key] = raw
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

/** A named template's values: its own fields, each by its type; a value it does not declare is dropped. */
export function parseTemplateValues(fields: readonly TemplateField[], values: Record<string, unknown>): ParsedValues {
  return parseFields(fields, values, fieldSchema, 'drop')
}

/** A request with its own source: every declared field by its type, and every other value as plain text. */
export function parseRequestValues(fields: readonly TemplateField[], values: Record<string, unknown>): ParsedValues {
  return parseFields(fields, values, valueSchema, 'check')
}

/** The typed fields of any request, with their defaults filled; every value was checked by type before. */
export function parseDocumentValues(fields: readonly TemplateField[], values: Record<string, unknown>): DocumentValues {
  const parsed = parseFields(fields, values, (field) => TYPED[field.fieldTypeKey], 'keep')
  if (parsed.ok) return parsed
  return { ok: false, errors: issuesAsErrors(parsed.issues) }
}

/** Field issues as the compile errors a render answers with. */
export function issuesAsErrors(issues: readonly FieldIssue[]): CompileError[] {
  return issues.map((i) => ({ severity: 'error', message: `${i.path.join('.')}: ${i.message}`, file: 'fields' }))
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
