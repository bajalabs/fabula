/* ZodValidationPipe: a request body checked against its zod schema. A body that does not fit is a 400:

     { "error": "validation_failed", "issues": [{ "path": [...], "message": "...", "code": "..." }] } */

import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common'
import type { z, ZodSchema } from 'zod'

@Injectable()
export class ZodValidationPipe<TSchema extends ZodSchema> implements PipeTransform<unknown, z.infer<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.infer<TSchema> {
    const result = this.schema.safeParse(value)
    if (!result.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: result.error.issues })
    }
    return result.data
  }
}
