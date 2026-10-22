import { Injectable, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '../auth/principal';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { ExportService } from '../common/export';
import { accessGrantExportColumns } from './access-grant-export';
import {
  AccessGrantsService,
  type FindAccessGrantsFilters,
} from './access-grants.service';

/** The one grant export behind `GET /access-grants/export` and `GET /applications/:id/access-grants/export`. */
@Injectable()
export class AccessGrantsExportService {
  constructor(
    private readonly grants: AccessGrantsService,
    private readonly exports: ExportService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * `auditFilters` is what the audit row records when it differs from the query filters — the
   * per-application route records the params actually sent (#1660, ADR-0103 §10).
   */
  async export(
    filters: FindAccessGrantsFilters,
    principal: Principal,
    response: Response,
    auditFilters: Record<string, unknown> = { ...filters },
  ): Promise<StreamableFile> {
    const [users, applications, serviceAccounts] = await Promise.all([
      this.permissions.principalHas(principal, 'user:read'),
      this.permissions.principalHas(principal, 'application:read'),
      this.permissions.principalHas(principal, 'settings:manage'),
    ]);
    return this.exports.exportCsv({
      resource: 'ACCESS_GRANTS',
      principal,
      response,
      filters: auditFilters,
      ...this.grants.exportSource(filters),
      columns: accessGrantExportColumns(
        { users, applications, serviceAccounts },
        new Date(),
      ),
      filename: 'access-grants',
    });
  }
}
