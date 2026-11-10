/* PDF options: accessible PDFs by default.

   engineConfig.pdf = { standards?: [...], tagged?: boolean }
     • tagged (default true): a Tagged PDF, the baseline a screen reader needs. Typst tags by default; WeasyPrint is
       asked to.
     • standards: 'ua-1' (PDF/UA-1) where the template is written for it, and one PDF/A level for documents that are
       kept ('a-2b', 'a-2u', 'a-2a', 'a-3b'). Typst (and Pandoc and Quarto through it) can combine ua-1 with a PDF/A
       level; WeasyPrint writes one variant at a time.
   An option the engine cannot honour fails the render with a clear error rather than producing a PDF that only looks
   compliant. */

import { z } from 'zod'
import type { CompileError } from './common.js'

export const PDF_STANDARDS = ['ua-1', 'a-2b', 'a-2u', 'a-2a', 'a-3b'] as const
export type PdfStandard = (typeof PDF_STANDARDS)[number]

export const pdfOptionsSchema = z
  .object({
    // duplicates are dropped below; one ua-1 and one PDF/A level remain at most
    standards: z.array(z.enum(PDF_STANDARDS)).max(8).default([]),
    tagged: z.boolean().default(true),
  })
  .strict()

export type PdfOptions = z.infer<typeof pdfOptionsSchema>

export type PdfOptionsResult = { ok: true; pdf: PdfOptions } | { ok: false; errors: CompileError[] }

const fail = (message: string): PdfOptionsResult => ({
  ok: false,
  errors: [{ severity: 'error', message: `engineConfig.pdf: ${message}`, file: 'engineConfig' }],
})

/** Read and check engineConfig.pdf; absent means tagged, no standard. */
export function readPdfOptions(engineConfig: Record<string, unknown> | undefined): PdfOptionsResult {
  const parsed = pdfOptionsSchema.safeParse(engineConfig?.pdf ?? {})
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'pdf'}: ${i.message}`).join('; '))
  }
  const pdf = parsed.data
  const standards = Array.from(new Set(pdf.standards))
  if (standards.filter((s) => s.startsWith('a-')).length > 1) return fail('one PDF/A level at a time')
  if (!pdf.tagged && standards.some((s) => s === 'ua-1' || s.endsWith('a'))) {
    return fail(`tagged: false cannot be combined with ${standards.join(', ')}, which require tags`)
  }
  return { ok: true, pdf: { ...pdf, standards } }
}

/** Typst's own flags: --pdf-standard ua-1,a-2b, or --no-pdf-tags. */
export function typstPdfArgs(pdf: PdfOptions): string[] {
  if (pdf.standards.length) return ['--pdf-standard', pdf.standards.join(',')]
  return pdf.tagged ? [] : ['--no-pdf-tags']
}

/** The same flags as Pandoc's --pdf-engine-opt, one option each. */
export function pandocPdfArgs(pdf: PdfOptions): string[] {
  if (pdf.standards.length) return [`--pdf-engine-opt=--pdf-standard=${pdf.standards.join(',')}`]
  return pdf.tagged ? [] : ['--pdf-engine-opt=--no-pdf-tags']
}

/** Quarto's typst format: `pdf-standard: [...]` (YAML lines under `typst:`). Quarto has no switch to turn
 *  Typst's tags off, so tagged: false is not honoured there. */
export function quartoPdfYaml(pdf: PdfOptions): string[] {
  return pdf.standards.length ? ['    pdf-standard:', ...pdf.standards.map((s) => `      - ${s}`)] : []
}

/** WeasyPrint: --pdf-tags, and --pdf-variant pdf/<standard> for one standard. */
export function weasyprintPdfArgs(pdf: PdfOptions): { ok: true; args: string[] } | { ok: false; errors: CompileError[] } {
  if (pdf.standards.length > 1) {
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          message: `engineConfig.pdf: WeasyPrint writes one PDF variant at a time (asked: ${pdf.standards.join(', ')})`,
          file: 'engineConfig',
        },
      ],
    }
  }
  const args = pdf.tagged ? ['--pdf-tags'] : []
  if (pdf.standards.length === 1) args.push('--pdf-variant', `pdf/${pdf.standards[0]}`)
  return { ok: true, args }
}
