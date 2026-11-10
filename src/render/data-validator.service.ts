/* DataValidatorService: values checked against a list of fields, by the same types a render checks
   (document-fields.ts), after a gentle coercion of text from CSV or a form: "42" for a number, "true" for a boolean,
   a parseable date as ISO 8601. Answers the issues and the coerced values, which a render then takes as they are. */

import { Injectable } from '@nestjs/common'
import { z, type ZodTypeAny } from 'zod'
import type { TemplateField, ValidateDataRequest, ValidateDataResponse, ValidationIssue } from '../contracts/index.js'
import { valueSchema } from './document-fields.js'

/** Text from CSV or a form, read as the field's type when it plainly is one; anything else is left for the schema. */
function coerce(fieldTypeKey: string, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const s = raw.trim()
  switch (fieldTypeKey) {
    case 'number':
    case 'integer':
    case 'money_cents':
      return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s) ? Number(s) : raw
    case 'boolean':
      return /^(true|false)$/i.test(s) ? s.toLowerCase() === 'true' : raw
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s
      const d = new Date(s)
      return Number.isNaN(d.getTime()) ? raw : d.toISOString()
    }
    default:
      return raw
  }
}

function buildFieldSchema(field: TemplateField): ZodTypeAny {
  return z.preprocess((v) => coerce(field.fieldTypeKey, v), valueSchema(field))
}

@Injectable()
export class DataValidatorService {
  validate(req: ValidateDataRequest): ValidateDataResponse {
    const issues: ValidationIssue[] = []
    const coerced: Record<string, unknown> = {}

    for (const field of req.fields) {
      const raw = Object.prototype.hasOwnProperty.call(req.values, field.key) ? req.values[field.key] : field.defaultValue

      // Missing and not required: left out, so the field's default applies
      if (raw === undefined || raw === null || raw === '') {
        if (field.isRequired) issues.push({ path: [field.key], message: `Required field "${field.key}" is missing` })
        continue
      }

      const result = buildFieldSchema(field).safeParse(raw)
      if (!result.success) {
        issues.push(...result.error.issues.map((i) => ({ path: [field.key, ...i.path.map(String)], message: i.message })))
      } else {
        coerced[field.key] = result.data
      }
    }

    return { ok: issues.length === 0, issues, coercedValues: issues.length === 0 ? coerced : undefined }
  }
}
