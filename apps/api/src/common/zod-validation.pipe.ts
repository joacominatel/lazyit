import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/**
 * Validates a request payload against a zod schema from @lazyit/shared.
 *
 * The shared schema is the single source of truth — `web` validates forms with
 * the same one. Use as `@Body(new ZodValidationPipe(CreateUserSchema))`.
 * See docs/03-decisions/0013-zod-validation-pipe.md.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(z.treeifyError(result.error));
    }
    return result.data;
  }
}
