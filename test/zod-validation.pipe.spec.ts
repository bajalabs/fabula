/* ZodValidationPipe: the body that fits, the failure's shape, and nested paths in the issues. */

import { describe, expect, it } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js'

describe('ZodValidationPipe', () => {
  const schema = z.object({
    format: z.enum(['typst', 'markdown', 'quarto', 'html', 'mjml', 'component']),
    output: z.enum(['pdf', 'png', 'jpeg', 'html']),
    source: z.string().min(1),
  })
  const pipe = new ZodValidationPipe(schema)

  it('returns the parsed value when input matches the schema', () => {
    const valid = {
      format: 'typst' as const,
      output: 'pdf' as const,
      source: '#set page(width: 100mm)',
    }
    expect(pipe.transform(valid)).toEqual(valid)
  })

  it('throws BadRequestException on invalid input', () => {
    expect(() =>
      pipe.transform({ format: 'unknown', output: 'gif', source: '' }),
    ).toThrow(BadRequestException)
  })

  it('reports issue paths so callers can pinpoint bad fields', () => {
    try {
      pipe.transform({ format: 'typst', output: 'gif', source: 'ok' })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException)
      const body = (err as BadRequestException).getResponse() as {
        error: string
        issues: Array<{ path: ReadonlyArray<string | number>; message: string }>
      }
      expect(body.error).toBe('validation_failed')
      expect(body.issues.some((i) => i.path.includes('output'))).toBe(true)
    }
  })

  it('strips unknown keys for non-strict schemas', () => {
    const result = pipe.transform({
      format: 'mjml',
      output: 'html',
      source: '<mjml/>',
      unknownExtra: 'ignored',
    })
    expect((result as Record<string, unknown>).unknownExtra).toBeUndefined()
  })
})
