/* Typst compile errors name the caller's own file, line and column. The entry file carries the field lets and a
   blank line before the caller's source, and Typst prints paths relative to the server's working directory; the
   parser maps both back. The stderr below is the shape Typst 0.15.1 prints. */

import { describe, expect, it } from 'vitest'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { composeSource, parseErrors } from '../src/render/engines/typst.engine.js'

const workDir = join(tmpdir(), 'fabula-typst-00000000-0000-4000-8000-000000000000')
const stderr = (file: string, line: number, column: number) =>
  `error: unknown variable: nope\n  ┌─ ${file}:${line}:${column}\n  │\n${line} │ #nope\n  │  ^^^^\n`

describe('Typst compile errors', () => {
  it('counts the lines composeSource puts before the caller source', () => {
    expect(composeSource('= Hello', [], {}).lineOffset).toBe(2)
    const two = composeSource('= Hello', [
      { key: 'a', label: 'A', fieldTypeKey: 'text', slotBinding: 'manual', required: false },
      { key: 'b', label: 'B', fieldTypeKey: 'text', slotBinding: 'manual', required: false },
    ] as never, { a: 'x', b: 'y' })
    expect(two.lineOffset).toBe(3)
    expect(two.source.split('\n')[two.lineOffset]).toBe('= Hello')
  })

  it("names main.typ and the caller's line, never the temp path", () => {
    const [e] = parseErrors(stderr(join(workDir, 'main.typ'), 5, 2), workDir, 2)
    expect(e).toMatchObject({ severity: 'error', file: 'main.typ', line: 3, column: 2 })
  })

  it('maps a path Typst printed relative to the working directory', () => {
    const rel = relative(process.cwd(), join(workDir, '_shared', 'brand.typ'))
    const [e] = parseErrors(stderr(rel, 12, 1), workDir, 2)
    expect(e.file).toBe('_shared/brand.typ')
    expect(e.line).toBe(12)
  })

  it('says fields when the error is in the injected lets', () => {
    const [e] = parseErrors(stderr(join(workDir, 'main.typ'), 1, 9), workDir, 3)
    expect(e).toMatchObject({ file: 'fields', line: 1 })
  })

  it('keeps a package path as Typst gave it, and a stray absolute path as its file name only', () => {
    expect(parseErrors(stderr('@preview/cetz:0.5.3/src/draw.typ', 4, 1), workDir, 2)[0].file).toBe('@preview/cetz:0.5.3/src/draw.typ')
    expect(parseErrors(stderr('/opt/elsewhere/x.typ', 4, 1), workDir, 2)[0].file).toBe('x.typ')
  })
})
