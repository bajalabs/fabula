/* What crosses the wire out of Fabula. `bytes` is base64, so the answer stays JSON. */

import { z } from 'zod'

import {
  renderFormatSchema,
  compileErrorSchema,
  validationIssueSchema,
} from './common.js'

// ── A page preview ─────────────────────────────────────────────────
export const pagePreviewSchema = z.object({
  page: z.number().int().positive(),
  mime: z.literal('image/png'),
  bytes: z.string(), // base64
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
})

export const renderSuccessSchema = z.object({
  ok: z.literal(true),
  mime: z.string(),
  bytes: z.string(), // base64
  durationMs: z.number().int(),
  warnings: z.array(compileErrorSchema).optional(),
  // With `previews`: at most maxPages pages, and how many the PDF has
  pages: z.array(pagePreviewSchema).optional(),
  pageCount: z.number().int().positive().optional(),
})

export const renderFailureSchema = z.object({
  ok: z.literal(false),
  errors: z.array(compileErrorSchema),
  durationMs: z.number().int().optional(),
})

export const renderResponseSchema = z.discriminatedUnion('ok', [
  renderSuccessSchema,
  renderFailureSchema,
])

// ── Data parsing response ──────────────────────────────────────────
export const parseDataResponseSchema = z.object({
  mode: z.enum(['single', 'batch']),
  records: z.array(z.record(z.string(), z.unknown())),
  fields: z.array(z.string()).optional(), // inferred column keys (CSV)
})

// ── Data validation response ───────────────────────────────────────
export const validateDataResponseSchema = z.object({
  ok: z.boolean(),
  issues: z.array(validationIssueSchema),
  coercedValues: z.record(z.string(), z.unknown()).optional(),
})

// ── Health response ────────────────────────────────────────────────
export const healthResponseSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  engines: z.array(renderFormatSchema),
  typstVersion: z.string().nullable().optional(),
  pandocVersion: z.string().nullable().optional(),
  quartoVersion: z.string().nullable().optional(),
  weasyprintVersion: z.string().nullable().optional(),
  mjmlVersion: z.string().nullable().optional(),
  uptimeSec: z.number().int(),
})

// ── Inferred types ──────────────────────────────────────────────────

export type RenderSuccess             = z.infer<typeof renderSuccessSchema>
export type PagePreview               = z.infer<typeof pagePreviewSchema>
export type RenderFailure             = z.infer<typeof renderFailureSchema>
export type RenderResponse            = z.infer<typeof renderResponseSchema>
export type ParseDataResponse         = z.infer<typeof parseDataResponseSchema>
export type ValidateDataResponse      = z.infer<typeof validateDataResponseSchema>
export type HealthResponse            = z.infer<typeof healthResponseSchema>
