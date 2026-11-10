/* The shapes shared by requests and responses: formats, outputs, the brand, template fields, document sections,
   compile errors. Pure zod, so a client can import them too. */

import { z } from 'zod'

// ── Supported formats + outputs ────────────────────────────────────
export const renderFormatSchema = z.enum([
  'typst',
  'quarto',
  'markdown',
  'html',
  'mjml',
  'docx', // a finished .docx read back (base64 source)
])

export const outputTypeSchema = z.enum([
  'pdf',
  'png',
  'jpeg',
  'html',
  'docx',
  'pptx',
])

export const dataSourceFormatSchema = z.enum([
  'csv',
  'json',
  'yaml',
  'toml',
  'manual',
])

// ── The brand ──────────────────────────────────────────────────────
// Colours, fonts, logos, legal blocks. Each font and logo file arrives as an https URL (a short-lived signed URL is
// fine) plus the sha256 of its bytes; BrandAssetsService fetches it from an allowed host and checks the hash.
export const BRAND_LIMITS = {
  colors: 64,
  fonts: 24,
  logos: 16,
  legal: 32,
} as const

export const brandHexSchema = z
  .string()
  .regex(/^#[0-9A-F]{6}$/i, 'hex must be #RRGGBB')
  .transform((s) => s.toUpperCase())

export const brandSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lower-case hex characters')

export const brandAssetUrlSchema = z
  .url({ protocol: /^https$/, error: 'asset url must be https' })
  .max(4096)

export const brandLocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'locale must be a BCP 47 tag like es-MX')

export const brandColorTokenSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'token must be letters, digits, - or _')

export const brandFontRoleSchema = z.enum(['heading', 'body', 'mono', 'display', 'accent'])
export const brandFontFormatSchema = z.enum(['woff2', 'woff', 'ttf', 'otf'])
export const brandLogoVariantSchema = z.enum(['primary', 'mark', 'wordmark', 'stacked', 'horizontal'])
export const brandLogoModeSchema = z.enum(['light', 'dark', 'mono'])
export const brandLogoFormatSchema = z.enum(['svg', 'png', 'pdf'])
export const brandLegalKindSchema = z.enum([
  'footer',
  'email_footer',
  'privacy',
  'consent',
  'disclaimer',
  'terms',
  'regulatory',
])

export const brandColorSchema = z.object({
  token: brandColorTokenSchema,
  hex: brandHexSchema,
  role: z.string().max(64).nullable().optional(),
  mode: z.enum(['light', 'dark']).default('light'),
})

export const brandFontSchema = z.object({
  role: brandFontRoleSchema,
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  family: z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001F\u007F]+$/, 'family has control characters'),
  weight: z.number().int().min(100).max(900).default(400),
  style: z.enum(['normal', 'italic']).default('normal'),
  format: brandFontFormatSchema,
  url: brandAssetUrlSchema,
  sha256: brandSha256Schema,
})

export const brandLogoSchema = z.object({
  variant: brandLogoVariantSchema,
  mode: brandLogoModeSchema.default('light'),
  format: brandLogoFormatSchema,
  url: brandAssetUrlSchema,
  sha256: brandSha256Schema,
  widthPx: z.number().int().positive().max(20_000).nullable().optional(),
  heightPx: z.number().int().positive().max(20_000).nullable().optional(),
  clearSpaceRatio: z.number().min(0).max(10).nullable().optional(),
  minWidthPx: z.number().int().positive().max(20_000).nullable().optional(),
  backgroundHex: brandHexSchema.nullable().optional(),
})

export const brandLegalSchema = z.object({
  market: z.string().min(1).max(32),
  locale: brandLocaleSchema,
  kind: brandLegalKindSchema,
  title: z.string().max(256).nullable().optional(),
  markdown: z.string().max(100_000),
})

// ── Brand identity ─────────────────────────────────────────────────
// Every field is optional: a request without a brand renders with neutral colours and the Noto fonts. The simple
// fields (primaryColor, fontBody, …) and the richer lists (colors, fonts, logos, legal) can be mixed; where both say
// the same thing, the list wins (a `primary` colour token over primaryColor, a `heading` font over fontHeading).
export const brandIdentitySchema = z.object({
  brandName: z.string().max(256).default(''),
  displayName: z.string().max(256).default(''),
  primaryColor: z.string().max(64).optional(),
  secondaryColor: z.string().max(64).optional(),
  accentColor: z.string().max(64).optional(),
  fontBody: z.string().max(128).default('Noto Sans'),
  fontHeading: z.string().max(128).default('Noto Sans'),
  companyLegalName: z.string().max(256).nullable().optional(),
  companyTaxId: z.string().max(64).nullable().optional(),
  companyAddress: z.string().max(512).nullable().optional(),
  companyEmail: z.string().max(256).nullable().optional(),
  companyPhone: z.string().max(64).nullable().optional(),
  companyWebsite: z.string().max(2048).nullable().optional(),
  tagline: z.string().max(512).nullable().optional(),
  locale: brandLocaleSchema.nullable().optional(),
  colors: z.array(brandColorSchema).max(BRAND_LIMITS.colors).optional(),
  fonts: z.array(brandFontSchema).max(BRAND_LIMITS.fonts).optional(),
  logos: z.array(brandLogoSchema).max(BRAND_LIMITS.logos).optional(),
  legal: z.array(brandLegalSchema).max(BRAND_LIMITS.legal).optional(),
})

// ── Template fields ────────────────────────────────────────────────
export const templateFieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'field key must be snake_case'),
  label: z.string(),
  fieldTypeKey: z.string(),
  isRequired: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  // A string field's length limit, in characters, when the default for its key does not fit
  maxLength: z.number().int().positive().max(1_000_000).optional(),
  description: z.string().optional(),
  options: z.unknown().optional(),
  sortOrder: z.number().int().default(0),
})

// ── Typed document fields (one-pager@1 and checklist@1) ────────────
// A template's field whose fieldTypeKey is `sections` or `contact` has this shape; TypstEngine checks it before the
// compile, so a wrong shape answers with the path of the value, not with a Typst error. Unknown keys are refused:
// these values reach Typst as dictionary literals, and a card's image is rewritten to a file in the work directory.
export const DOCUMENT_LIMITS = {
  sections: 12,
  items: 24,
  images: 12,
} as const

const docLine = z.string().trim().min(1).max(300)
const docProse = z.string().trim().min(1).max(2000)
const docColumns = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback)
const docItems = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(DOCUMENT_LIMITS.items)

/** A picture by reference: fetched like a brand file (BrandAssetsService). `alt` is required: the PDFs are PDF/UA-1. */
export const documentImageSchema = z
  .object({ url: brandAssetUrlSchema, sha256: brandSha256Schema, alt: docLine })
  .strict()

const textSection = z
  .object({
    kind: z.literal('text'),
    title: docLine.optional(),
    body: docProse,
    // plain: as it comes; box: a ruled box; quiet: centred and muted
    style: z.enum(['plain', 'box', 'quiet']).default('plain'),
  })
  .strict()

const pointsSection = z
  .object({
    kind: z.literal('points'),
    title: docLine.optional(),
    intro: docProse.optional(),
    columns: docColumns(4, 2),
    items: docItems(z.object({ title: docLine, body: docProse }).strict()),
  })
  .strict()

const cardsSection = z
  .object({
    kind: z.literal('cards'),
    title: docLine.optional(),
    intro: docProse.optional(),
    columns: docColumns(4, 3),
    items: docItems(
      z
        .object({
          title: docLine,
          body: docProse.optional(),
          // small and muted, one per line, under the body
          lines: z.array(docLine).max(6).optional(),
          image: documentImageSchema.optional(),
        })
        .strict(),
    ),
    // one more cell after the cards, in the brand's primary colour
    closing: docProse.optional(),
  })
  .strict()

const stepsSection = z
  .object({
    kind: z.literal('steps'),
    title: docLine.optional(),
    intro: docProse.optional(),
    // 1: down the page, the number beside the text; more: across, the number above it
    columns: docColumns(6, 1),
    items: docItems(z.object({ title: docLine, body: docProse }).strict()),
  })
  .strict()

const factsSection = z
  .object({
    kind: z.literal('facts'),
    title: docLine.optional(),
    items: docItems(z.object({ label: docLine, value: docLine }).strict()),
    note: docProse.optional(),
  })
  .strict()

const checksSection = z
  .object({
    kind: z.literal('checks'),
    title: docLine.optional(),
    intro: docProse.optional(),
    columns: docColumns(2, 1),
    // a box beside each item; a long item hangs beside its box
    items: docItems(
      z.union([docProse, z.object({ title: docLine.optional(), body: docProse }).strict()]).transform((i) => (typeof i === 'string' ? { body: i } : i)),
    ),
    note: docProse.optional(),
    // on the brand's tint, as the first thing a reader must do
    boxed: z.boolean().default(false),
  })
  .strict()

const leafSection = z.discriminatedUnion('kind', [textSection, pointsSection, cardsSection, stepsSection, factsSection, checksSection])

const rowSection = z
  .object({
    kind: z.literal('row'),
    title: docLine.optional(),
    left: z.array(leafSection).min(1).max(DOCUMENT_LIMITS.sections),
    right: z.array(leafSection).min(1).max(DOCUMENT_LIMITS.sections),
  })
  .strict()

export const documentSectionSchema = z.discriminatedUnion('kind', [
  textSection,
  pointsSection,
  cardsSection,
  stepsSection,
  factsSection,
  checksSection,
  rowSection,
])

export const documentSectionsSchema = z.array(documentSectionSchema).max(DOCUMENT_LIMITS.sections)

export const documentContactSchema = z
  .object({
    title: docLine,
    line: docProse.optional(),
    cta_label: docLine.optional(),
    cta_url: z.url({ protocol: /^https$/, error: 'cta_url must be https' }).max(2048).optional(),
  })
  .strict()
  .refine((c) => Boolean(c.cta_label) === Boolean(c.cta_url), { message: 'cta_label and cta_url come together' })

// ── Compile errors ─────────────────────────────────────────────────
export const compileErrorSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
})

// ── Validation issues (used by validate-data response) ─────────────
export const validationIssueSchema = z.object({
  path: z.array(z.string()),
  message: z.string(),
})

// ── Inferred TypeScript types ──────────────────────────────────────

export type RenderFormat       = z.infer<typeof renderFormatSchema>
export type OutputType         = z.infer<typeof outputTypeSchema>
export type DataSourceFormat   = z.infer<typeof dataSourceFormatSchema>

export type BrandIdentity      = z.infer<typeof brandIdentitySchema>
export type BrandColor         = z.infer<typeof brandColorSchema>
export type BrandFont          = z.infer<typeof brandFontSchema>
export type BrandLogo          = z.infer<typeof brandLogoSchema>
export type BrandLegal         = z.infer<typeof brandLegalSchema>
export type BrandFontRole      = z.infer<typeof brandFontRoleSchema>
export type BrandFontFormat    = z.infer<typeof brandFontFormatSchema>
export type BrandLogoVariant   = z.infer<typeof brandLogoVariantSchema>
export type BrandLogoMode      = z.infer<typeof brandLogoModeSchema>
export type BrandLogoFormat    = z.infer<typeof brandLogoFormatSchema>
export type BrandLegalKind     = z.infer<typeof brandLegalKindSchema>
export type TemplateField      = z.infer<typeof templateFieldSchema>
export type CompileError       = z.infer<typeof compileErrorSchema>
export type ValidationIssue    = z.infer<typeof validationIssueSchema>

