/* DataParserService: CSV (with its values cast), JSON, YAML and TOML to records, and content that does not parse as
   a 400. It guards the parsers' own upgrades (csv-parse, yaml, smol-toml). */

import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { DataParserService } from '../src/render/data-parser.service.js'

const parser = new DataParserService()

describe('DataParserService', () => {
  it('reads CSV with a header row, casting numbers, booleans and empty cells', () => {
    const csv = 'name, loaves ,price,organic,note\nRye,12,4.50,true,\n"Sourdough, large",8,-6.25,FALSE,"says ""hi"""\n'
    expect(parser.parse({ sourceFormat: 'csv', content: csv })).toEqual({
      mode: 'batch',
      fields: ['name', 'loaves', 'price', 'organic', 'note'],
      records: [
        { name: 'Rye', loaves: 12, price: 4.5, organic: true, note: null },
        { name: 'Sourdough, large', loaves: 8, price: -6.25, organic: false, note: 'says "hi"' },
      ],
    })
  })

  it('reads JSON, YAML and TOML', () => {
    expect(parser.parse({ sourceFormat: 'json', content: '[{"a":1},{"a":2},3]' })).toEqual({ mode: 'batch', records: [{ a: 1 }, { a: 2 }] })
    expect(parser.parse({ sourceFormat: 'yaml', content: 'title: Hello\nitems:\n  - one\n  - two\n' })).toEqual({
      mode: 'single',
      records: [{ title: 'Hello', items: ['one', 'two'] }],
    })
    expect(parser.parse({ sourceFormat: 'toml', content: 'title = "Hello"\n[shop]\nopen = true\n' })).toEqual({
      mode: 'single',
      records: [{ title: 'Hello', shop: { open: true } }],
    })
  })

  it('answers 400 naming the format for content that does not parse', () => {
    for (const [sourceFormat, content] of [['json', '{nope'], ['yaml', 'a: [1, 2'], ['toml', 'a = '], ['csv', 'a,b\n"unclosed']] as const) {
      expect(() => parser.parse({ sourceFormat, content }), sourceFormat).toThrow(BadRequestException)
    }
  })
})
