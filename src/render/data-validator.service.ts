/* DataValidatorService: values checked against a list of fields, by each field's type; answers the issues and the
   coerced values. */

import { Injectable } from '@nestjs/common'
import { z, ZodError, type ZodTypeAny } from 'zod'
import { documentContactSchema, documentSectionsSchema } from '../contracts/index.js'
import type {
  TemplateField,
  ValidateDataRequest,
  ValidateDataResponse,
  ValidationIssue,
} from '../contracts/index.js'

// A field type's key → its zod schema.
function baseSchemaFor(fieldTypeKey: string): ZodTypeAny {
  switch (fieldTypeKey) {
    case 'number':
      return z.coerce.number()
    case 'boolean':
      return z.coerce.boolean()
    case 'date':
    case 'datetime':
      return z.coerce.date().transform((d) => d.toISOString())
    case 'money_cents':
      return z.coerce.number().int()
    case 'object':
    case 'address':
      return z.record(z.string(), z.unknown())
    case 'array':
      return z.array(z.unknown())
    case 'sections':
      return documentSectionsSchema
    case 'contact':
      return documentContactSchema
    case 'email':
      return z.string().email()
    case 'url':
      return z.string().url()
    case 'string':
    case 'long_text':
    case 'phone':
    case 'rich_text':
    case 'image_url':
    case 'signature':
    case 'enum':
    default:
      return z.string()
  }
}

function buildFieldSchema(field: TemplateField): ZodTypeAny {
  let schema = baseSchemaFor(field.fieldTypeKey)
  if (!field.isRequired) schema = schema.optional().nullable()
  return schema
}

@Injectable()
export class DataValidatorService {
  validate(req: ValidateDataRequest): ValidateDataResponse {
    const issues: ValidationIssue[] = []
    const coerced: Record<string, unknown> = {}

    for (const field of req.fields) {
      const schema = buildFieldSchema(field)
      const raw = Object.prototype.hasOwnProperty.call(req.values, field.key)
        ? req.values[field.key]
        : field.defaultValue

      // Missing + not required = leave out (handled by engine default)
      if (raw === undefined || raw === null || raw === '') {
        if (field.isRequired) {
          issues.push({
            path: [field.key],
            message: `Required field "${field.key}" is missing`,
          })
        }
        continue
      }

      const result = schema.safeParse(raw)
      if (!result.success) {
        issues.push(...zodErrorToIssues(result.error, field.key))
      } else {
        coerced[field.key] = result.data
      }
    }

    return {
      ok: issues.length === 0,
      issues,
      coercedValues: issues.length === 0 ? coerced : undefined,
    }
  }
}

function zodErrorToIssues(err: ZodError, fieldKey: string): ValidationIssue[] {
  return err.issues.map((i) => ({
    path: [fieldKey, ...i.path.map(String)],
    message: i.message,
  }))
}
