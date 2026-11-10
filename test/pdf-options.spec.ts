/* PDF options: tagged by default, PDF/UA-1 and PDF/A when a template asks, and each engine's own switches for them. */

import { describe, expect, it } from 'vitest'
import {
  pandocPdfArgs,
  quartoPdfYaml,
  readPdfOptions,
  typstPdfArgs,
  weasyprintPdfArgs,
} from '../src/contracts/pdf-options.js'

const read = (pdf?: unknown) => readPdfOptions(pdf === undefined ? {} : { pdf })

describe('readPdfOptions', () => {
  it('defaults to a tagged PDF with no standard', () => {
    expect(read()).toEqual({ ok: true, pdf: { standards: [], tagged: true } })
  })

  it('takes PDF/UA-1 with one PDF/A level, once each', () => {
    expect(read({ standards: ['ua-1', 'a-2b', 'ua-1'] })).toEqual({ ok: true, pdf: { standards: ['ua-1', 'a-2b'], tagged: true } })
  })

  it('refuses an unknown standard, two PDF/A levels, unknown keys and untagged UA', () => {
    expect(read({ standards: ['x-1a'] }).ok).toBe(false)
    expect(read({ standards: ['a-2b', 'a-3b'] }).ok).toBe(false)
    expect(read({ standards: [], extra: true }).ok).toBe(false)
    const r = read({ standards: ['ua-1'], tagged: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ file: 'engineConfig', severity: 'error' })
  })

  it('allows an untagged PDF/A-2b, which does not require tags', () => {
    expect(read({ standards: ['a-2b'], tagged: false }).ok).toBe(true)
  })
})

describe('the engines’ switches', () => {
  const opts = (pdf: unknown) => {
    const r = read(pdf)
    if (!r.ok) throw new Error('bad options')
    return r.pdf
  }

  it('Typst: nothing by default, --pdf-standard for standards, --no-pdf-tags when untagged', () => {
    expect(typstPdfArgs(opts({}))).toEqual([])
    expect(typstPdfArgs(opts({ standards: ['ua-1', 'a-2b'] }))).toEqual(['--pdf-standard', 'ua-1,a-2b'])
    expect(typstPdfArgs(opts({ tagged: false }))).toEqual(['--no-pdf-tags'])
  })

  it('Pandoc: the same through --pdf-engine-opt', () => {
    expect(pandocPdfArgs(opts({}))).toEqual([])
    expect(pandocPdfArgs(opts({ standards: ['ua-1'] }))).toEqual(['--pdf-engine-opt=--pdf-standard=ua-1'])
    expect(pandocPdfArgs(opts({ tagged: false }))).toEqual(['--pdf-engine-opt=--no-pdf-tags'])
  })

  it('Quarto: pdf-standard under the typst format', () => {
    expect(quartoPdfYaml(opts({}))).toEqual([])
    expect(quartoPdfYaml(opts({ standards: ['ua-1', 'a-2b'] }))).toEqual(['    pdf-standard:', '      - ua-1', '      - a-2b'])
  })

  it('WeasyPrint: --pdf-tags by default, one --pdf-variant, two refused', () => {
    expect(weasyprintPdfArgs(opts({}))).toEqual({ ok: true, args: ['--pdf-tags'] })
    expect(weasyprintPdfArgs(opts({ standards: ['a-2b'] }))).toEqual({ ok: true, args: ['--pdf-tags', '--pdf-variant', 'pdf/a-2b'] })
    expect(weasyprintPdfArgs(opts({ standards: ['ua-1', 'a-2b'] })).ok).toBe(false)
  })
})
