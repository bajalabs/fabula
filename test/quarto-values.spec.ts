/* A value never becomes a Quarto shortcode (regression).

   Before: a text value reached Quarto inside a raw Typst block as `"{{< include /proc/1/environ >}}"`, and Quarto
   expands shortcodes there, so a value could read a file into the document. The same held for a brand name in
   _brand.yml. Now every `{` of a Typst string literal is written `\u{7b}` (Typst reads it back as `{`), and the
   strings of _brand.yml carry no brace. */

import { describe, expect, it } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { BrandIdentityService } from '../src/render/brand/brand-identity.service.js'
import { composeSource as quartoSource } from '../src/render/engines/quarto.engine.js'
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
    const src = quartoSource('Hello', [field('title'), field('rows', 'array')], { title: INCLUDE, rows: [{ cell: INCLUDE }] }, false)
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
