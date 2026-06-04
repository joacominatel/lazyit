import { Module } from '@nestjs/common';
import { UserHistoryService } from './user-history.service';

/**
 * Provides the {@link UserHistoryService} (DEBT-2, issue #185). Imported by the Users module, which
 * emits user lifecycle events (create / update / role change / offboard / restore / password-reset),
 * mirroring how {@link AssetHistoryModule} serves the asset write-paths.
 */
@Module({
  providers: [UserHistoryService],
  exports: [UserHistoryService],
})
export class UserHistoryModule {}
