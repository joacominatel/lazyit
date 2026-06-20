import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ImportController } from './import.controller';
import { ImportSessionService } from './import-session.service';
import { ImportDryRunService } from './dry-run.service';
import { ImportCommitService } from './import-commit.service';
import { ImportCommitWorker } from './import-commit.worker';
import { ImportSessionGcSweeper } from './import-session-gc.sweeper';
import { AssetsModule } from '../assets/assets.module';
import { AssetModelsModule } from '../asset-models/asset-models.module';
import { AssetCategoriesModule } from '../asset-categories/asset-categories.module';
import { LocationsModule } from '../locations/locations.module';
import { UsersModule } from '../users/users.module';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
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
 * Wave 4b (#635) adds the HTTP surface ({@link ImportController}), the `import:run` permission + the
 * runtime per-target authz at commit, and the expired-session GC sweeper ({@link ImportSessionGcSweeper}).
 * The `import:run` route guard + the human-only guard live on the controller; the runtime AND-check
 * lives in {@link ImportCommitService}. The `PermissionResolverService` it injects comes from the
 * `@Global()` AuthModule (no explicit import needed).
 */
@Module({
  imports: [
    AssetsModule,
    AssetModelsModule,
    AssetCategoriesModule,
    LocationsModule,
    // ADR-0069 REDESIGN §4.5/§4.6 (Etapa 2): the commit engine creates directory-only persons through
    // UsersService (skipIdpWriteBack) and opens AssetAssignments through AssetAssignmentsService.
    UsersModule,
    AssetAssignmentsModule,
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
  controllers: [ImportController],
  providers: [
    ImportSessionService,
    ImportDryRunService,
    ImportCommitService,
    ImportCommitWorker,
    ImportSessionGcSweeper,
  ],
  exports: [ImportSessionService, ImportDryRunService, ImportCommitService],
})
export class ImportModule {}
