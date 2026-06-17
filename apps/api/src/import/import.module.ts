import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ImportSessionService } from './import-session.service';
import { ImportDryRunService } from './dry-run.service';
import { ImportCommitService } from './import-commit.service';
import { ImportCommitWorker } from './import-commit.worker';
import { AssetsModule } from '../assets/assets.module';
import { AssetModelsModule } from '../asset-models/asset-models.module';
import { LocationsModule } from '../locations/locations.module';
import {
  IMPORT_PARSE_QUEUE,
  parseChildHeapMb,
  parseProcessorPath,
} from './import-job.constants';
import { IMPORT_COMMIT_QUEUE } from './import-commit.constants';

/**
 * The migrator module (ADR-0069). Registers two queues:
 *
 * - `import-parse` (wave 2, #629) — a SANDBOXED forked processor (`--max-old-space-size`), so a
 *   pathological CSV/JSON OOMs the child and never the API process (SEC-002). Concurrency 1.
 * - `import-commit` (wave 4a, #633) — an IN-PROCESS `@Processor` ({@link ImportCommitWorker}), because
 *   the commit MUST route every write through the Nest-DI `AssetsService.create()` (history + actor +
 *   asset-tag invariants) which a DI-less forked child can't reach. There is no file-bomb surface at
 *   commit time (the bytes were discarded after parse), so the parse child's isolation isn't needed.
 *
 * The HTTP controllers + the `import:run` permission + runtime authz land in wave 4b; the session,
 * dry-run and commit services are driven by methods + the workers (and by Jest) for now.
 */
@Module({
  imports: [
    AssetsModule,
    AssetModelsModule,
    LocationsModule,
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
    // In-process commit queue — no `processors:` array (the @Processor class is a DI provider below).
    BullModule.registerQueue({ name: IMPORT_COMMIT_QUEUE }),
  ],
  providers: [
    ImportSessionService,
    ImportDryRunService,
    ImportCommitService,
    ImportCommitWorker,
  ],
  exports: [ImportSessionService, ImportDryRunService, ImportCommitService],
})
export class ImportModule {}
