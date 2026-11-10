/* A value never becomes a Quarto shortcode (regression).

   Before: a text value reached Quarto inside a raw Typst block as `"{{< include /proc/1/environ >}}"`, and Quarto
   expands shortcodes there, so a value could read a file into the document. The same held for a brand name in
   _brand.yml. Now every `{` of a Typst string literal is written `\u{7b}` (Typst reads it back as `{`), and the
   strings of _brand.yml carry no brace. */

import { describe, expect, it } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { composeSource as quartoSource, parseErrors as parseQuartoErrors } from '../src/render/engines/quarto.engine.js'
import { composeSource as typstSource } from '../src/render/engines/typst.engine.js'
import { toTypstLiteral } from '../src/util/typst-literal.js'

const INCLUDE = '{{< include /proc/1/environ >}}'
const field = (key: string, fieldTypeKey = 'string') => ({ key, label: key, fieldTypeKey, isRequired: false, sortOrder: 0 })

describe('toTypstLiteral', () => {
  it('writes { as \\u{7b}, so no shortcode survives in a string', () => {
    expect(toTypstLiteral(INCLUDE)).toBe('"\\u{7b}\\u{7b}< include /proc/1/environ >}}"')
    expect(toTypstLiteral({ [INCLUDE]: [INCLUDE] })).not.toContain('{{')
  })

  it('leaves every other string as it was', () => {
    expect(toTypstLiteral('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\nd"')
  })
})

describe('what Quarto reads', () => {
  it('has no {{ from a value, in a text field or inside a list', () => {
    const src = quartoSource('Hello', [field('title'), field('rows', 'array')], { title: INCLUDE, rows: [{ cell: INCLUDE }] })
    expect(src).not.toContain('{{')
    expect(src).toContain('#let title = "\\u{7b}\\u{7b}< include')
  })

  it('has no {{ from the brand in _brand.yml', () => {
    const brand = brandIdentitySchema.parse({
      displayName: INCLUDE,
      brandName: INCLUDE,
      colors: [{ token: 'primary', hex: '#0E7C66' }],
      fontBody: `Inter ${INCLUDE}`,
    })
    const yml = new BrandIdentityService().buildQuartoBrand(brand)
    expect(yml).not.toBeNull()
    expect(yml).not.toContain('{')
  })
})

describe('what Typst reads', () => {
  it('is the same value: only the spelling of { changes', () => {
    const { source } = typstSource('#title', [field('title') as never], { title: 'a {b} c' })
    expect(source.split('\n')[0]).toBe('#let title = "a \\u{7b}b} c"')
  })
})

/* Quarto's errors (regression). Quarto colours its lines and prints its settings first; the parser matched `ERROR:`
   only at a line's very start, so a coloured line never matched and the answer was the first 1500 characters of
   stderr: the settings, not the failure. The stderr below is the shape Quarto 1.11.9 printed in the image. */
describe('Quarto’s errors', () => {
  const stderr = [
    '\u001b[1mpandoc \u001b[22m',
    '  to: typst',
    '  output-file: main.typ',
    '\u001b[1mmetadata\u001b[22m',
    '  lang: en',
    '[typst]: Compiling main.typ to main.pdf...error: unknown variable: font-body',
    '    ┌─ main.typ:394:16',
    '\u001b[91mERROR: error: unknown variable: font-body',
    '    ┌─ main.typ:394:16',
    '',
    '\u001b[91mERROR: Typst compilation failed\u001b[39m',
  ].join('\n')

  it('answers the failure, without colours, once', () => {
    expect(parseQuartoErrors(stderr)).toEqual([
      { severity: 'error', message: 'unknown variable: font-body' },
      { severity: 'error', message: 'Typst compilation failed' },
    ])
  })

  it('answers the last lines when no line says ERROR', () => {
    const out = parseQuartoErrors('\u001b[1mpandoc \u001b[22m\n  to: typst\nsomething broke at the end')
    expect(out).toHaveLength(1)
    expect(out[0].message).toContain('something broke at the end')
    expect(out[0].message).not.toContain('\u001b')
  })
})
