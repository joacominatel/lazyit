import { Module } from '@nestjs/common';
import { ExportLimiter } from './export-limiter';
import { ExportService } from './export.service';

/** Imported by each module that serves a `GET …/export` route; one limiter for the whole app. */
@Module({
  providers: [ExportService, ExportLimiter],
  exports: [ExportService],
})
export class ExportModule {}
