import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ImportSessionService } from './import-session.service';
import { ImportDryRunService } from './dry-run.service';
import {
  IMPORT_PARSE_QUEUE,
  parseChildHeapMb,
  parseProcessorPath,
} from './import-job.constants';

/**
 * The migrator INGEST module (ADR-0069 wave 2, #629). Registers the `import-parse` queue with a
 * BullMQ SANDBOXED processor — a forked Node child launched with `--max-old-space-size`, so a
 * pathological CSV/JSON OOMs the child (BullMQ marks the job failed) and never the API process
 * (SEC-002, mirroring the article-import harness). Concurrency 1 keeps memory pressure bounded.
 *
 * No controllers yet: the upload/map/dry-run/commit HTTP surface + the `import:run` permission land
 * in wave 4. The session + dry-run services are driven by methods + the worker for now.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: IMPORT_PARSE_QUEUE,
      processors: [
        {
          path: parseProcessorPath(),
          concurrency: 1,
          workerForkOptions: {
            execArgv: [`--max-old-space-size=${parseChildHeapMb()}`],
          },
        },
      ],
    }),
  ],
  providers: [ImportSessionService, ImportDryRunService],
  exports: [ImportSessionService, ImportDryRunService],
})
export class ImportModule {}
