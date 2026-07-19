import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { UserHistoryModule } from '../user-history/user-history.module';
import { DirectoryController } from './directory.controller';
import { DirectoryConnectionService } from './directory-connection.service';
import { DirectoryLdapClient } from './directory-ldap.client';
import { DirectoryReconcileService } from './directory-reconcile.service';
import { DirectorySyncSweeper } from './directory-sync.sweeper';

/**
 * DirectoryModule — on-prem AD/LDAP directory source (issue #839, ADR-0091). Hosts the `/directory`
 * surface (`GET`/`PUT connection`, `POST sync`), the singleton config store, the read-only ldapts client,
 * the reconcile engine, and the setInterval sweeper.
 *
 * PrismaService (global PrismaModule) and PermissionResolverService (global AuthModule) inject without an
 * explicit import. UsersModule provides the sanctioned directory-person CREATE rail (users.service.create,
 * skipIdpWriteBack), and UserHistoryModule the append-only audit writer for matched/offboard rows.
 */
@Module({
  imports: [UsersModule, UserHistoryModule],
  controllers: [DirectoryController],
  providers: [
    DirectoryConnectionService,
    DirectoryLdapClient,
    DirectoryReconcileService,
    DirectorySyncSweeper,
  ],
  exports: [DirectoryConnectionService, DirectoryReconcileService],
})
export class DirectoryModule {}
