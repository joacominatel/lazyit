import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Security audit-log READ surface (issue #871, ADR-0081). Hosts the reader for the three security
 * audit logs (`SecretAuditLog`, `PermissionAuditLog`, `ServiceAccountAuditLog`) — read + filtered CSV
 * export, all gated on `logs:read`. Reader-only; the writers stay in SecretManager / PermissionsConfig
 * / ServiceAccounts (disjoint lanes). No schema change — PrismaService comes from the global
 * PrismaModule. INV-10-safe: secret refs resolve to metadata display names only.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
