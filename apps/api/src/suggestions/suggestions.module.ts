import { Module } from '@nestjs/common';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

/** Smart-entry suggestions (ADR-0099 §7): `GET /suggestions/:field`. Read-only; no schema of its own. */
@Module({
  controllers: [SuggestionsController],
  providers: [SuggestionsService],
})
export class SuggestionsModule {}
