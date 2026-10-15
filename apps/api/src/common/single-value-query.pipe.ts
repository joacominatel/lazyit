import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';

const SCALAR_TYPES: ReadonlySet<unknown> = new Set([String, Number, Boolean]);

// Express turns `?q=a&q=b` into an array; a param typed `string | string[]` opts into that (AUD-066).
@Injectable()
export class SingleValueQueryPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (
      metadata.type === 'query' &&
      metadata.data !== undefined &&
      Array.isArray(value) &&
      SCALAR_TYPES.has(metadata.metatype)
    ) {
      throw new BadRequestException(
        `Invalid ${metadata.data}: expected a single value`,
      );
    }
    return value;
  }
}
