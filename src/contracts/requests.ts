/* What crosses the wire into Fabula: the render request, the data requests. Checked by ZodValidationPipe. */

import { z } from 'zod'

import {
  renderFormatSchema,
  outputTypeSchema,
  dataSourceFormatSchema,
  brandIdentitySchema,
  templateFieldSchema,
  compileErrorSchema,
} from './common.js'

// ── Page previews: a PNG of every page of a PDF render ────────────
export const previewOptionsSchema = z
  .object({
    ppi: z.number().int().min(36).max(300).default(110),
    maxPages: z.number().int().min(1).max(50).default(20),
  })
  .strict()

// ── The render request ─────────────────────────────────────────────
// `source` is the template's source code; a named template becomes one of these first (TemplateRegistryService).
export const renderRequestSchema = z.object({
  format: renderFormatSchema,
  source: z.string(),
  output: outputTypeSchema.default('pdf'),
  brand: brandIdentitySchema.default(brandIdentitySchema.parse({})),
  fields: z.array(templateFieldSchema).default([]),
  values: z.record(z.string(), z.unknown()).default({}),
  engineConfig: z.record(z.string(), z.unknown()).default({}),
  // A PNG of every page, beside the PDF (PDF outputs only)
  previews: previewOptionsSchema.optional(),
  // Optional render identity, echoed into the logs
  meta: z
    .object({
      templateId: z.string().optional(),
      templateVersion: z.number().int().optional(),
      requestId: z.string().max(128).optional(),
    })
    .optional(),
})

// ── Templates by name ──────────────────────────────────────────────
// A template lives as templates/<kind>/<name>/v<version>/ (template.json + its entry file) and is
// called as `<name>@<version>`; a request carries either a template or its own source, never both.
export const templateIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}@[1-9][0-9]{0,3}$/, 'template must be name@version, e.g. checklist@1')

export const templateManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    kind: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    version: z.number().int().min(1).max(9999),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    format: renderFormatSchema,
    output: outputTypeSchema.default('pdf'),
    entry: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    fields: z.array(templateFieldSchema).default([]),
    engineConfig: z.record(z.string(), z.unknown()).default({}),
    sample: z.record(z.string(), z.unknown()).default({}),
    // Where the head draws the logo: on a band of the primary colour, or on the page. A brand without that file gets a
    // warning on its render
    headLogo: z.enum(['band', 'page']).optional(),
  })
  .strict()

/** What /render accepts: a template by name, or a source with its format (the source-in-request path, kept). */
export const renderInputSchema = renderRequestSchema
  .extend({
    format: renderFormatSchema.optional(),
    source: z.string().optional(),
    output: outputTypeSchema.optional(),
    template: templateIdSchema.optional(),
    // A long render: answered 202 with the job id, its result POSTed to url, signed
    callback: z
      .object({ url: z.string().min(1).max(2048), id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional() })
      .strict()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.template && v.source !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: 'a request carries a template or a source, not both' })
    }
    if (!v.template && (v.source === undefined || !v.format)) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'without a template, source and format are required' })
    }
  })

// ── Data parsing (CSV/JSON/YAML/TOML → records) ────────────────────
export const parseDataRequestSchema = z.object({
  sourceFormat: dataSourceFormatSchema,
  content: z.string(),
  fileName: z.string().optional(),
})

// ── Data validation (values against a template's field schema) ─────
export const validateDataRequestSchema = z.object({
  fields: z.array(templateFieldSchema),
  values: z.record(z.string(), z.unknown()),
})

// ── Inferred types ──────────────────────────────────────────────────

export type RenderRequest             = z.infer<typeof renderRequestSchema>
export type PreviewOptions            = z.infer<typeof previewOptionsSchema>
export type TemplateManifest          = z.infer<typeof templateManifestSchema>
export type RenderInput               = z.infer<typeof renderInputSchema>
export type ParseDataRequest          = z.infer<typeof parseDataRequestSchema>
export type ValidateDataRequest       = z.infer<typeof validateDataRequestSchema>

export { compileErrorSchema }
