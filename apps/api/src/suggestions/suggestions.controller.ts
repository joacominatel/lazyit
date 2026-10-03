import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  SuggestionFieldSchema,
  SuggestionQuerySchema,
  SuggestionSchema,
} from '@lazyit/shared';
import { SuggestionsService } from './suggestions.service';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';

class SuggestionDto extends createZodDto(SuggestionSchema) {}

/**
 * Smart-entry suggestions (ADR-0099 §7). Deliberately NOT gated by one `@RequirePermission`: a field may
 * merge sources guarded by different permissions, so the service authorizes each source and refuses the
 * field (403) when the caller may read none. Unannotated, the route stays fail-closed for a service
 * account (INV-SA-2) — suggestions are a typing aid for people, not an integration surface.
 */
@ApiTags('suggestions')
@Controller('suggestions')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get(':field')
  @ApiOperation({
    summary:
      "Values already used for a free-text field, ranked by use count then last use. 403 when the caller may read none of the field's sources.",
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Case-insensitive substring the value must contain',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Default 10, max 50 (a larger value is a 400).',
  })
  @ApiOkResponse({ type: [SuggestionDto] })
  suggest(
    @Param('field') field: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const parsedField = SuggestionFieldSchema.safeParse(field);
    if (!parsedField.success) {
      throw new BadRequestException(
        `Unknown suggestion field. Expected one of: ${SuggestionFieldSchema.options.join(', ')}`,
      );
    }
    const query = SuggestionQuerySchema.safeParse({ q, limit });
    if (!query.success) {
      throw new BadRequestException(
        'Invalid query: q is at most 200 characters and limit is an integer from 1 to 50',
      );
    }
    return this.suggestions.suggest(parsedField.data, query.data, principal);
  }
}
