import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { AUDIT_LOG_CSV_HEADER } from '@lazyit/shared';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import type { ExportService } from '../common/export';
import { EXPORT_BATCH_SIZE, keysetBatches } from '../common/export/keyset';
import { streamCsv } from '../common/export/stream-csv';
import { PERMISSION_KEY } from '../auth/require-permission.decorator';
import type { PrismaService } from '../prisma/prisma.service';

// The service uses the generated `Prisma` namespace ONLY for erased type annotations/casts, so an empty
// mock is enough — no real client (and no DB) is ever loaded. Mirrors the dashboard export spec.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Unit spec for the security audit-log READ surface (issue #871, ADR-0081). Covers, without a DB:
 *  - the readers page + filter correctly PER SOURCE (secret / permission / serviceAccount);
 *  - the INV-10 invariant — the secret read/export resolves METADATA ONLY (vault name / item label),
 *    never plaintext/ciphertext, and never selects the ciphertext columns;
 *  - CSV escaping incl. the formula-injection guard, via the shared util (a vault literally named
 *    `=cmd|…` is neutralized at the export boundary);
 *  - the SA-actor row resolves to a name/prefix, and a DANGLING soft-ref degrades to the raw id (no crash);
 *  - the `logs:read` gate is declared on every endpoint.
 */

interface FakePrisma {
  $transaction: jest.Mock;
  secretAuditLog: { findMany: jest.Mock; count: jest.Mock };
  permissionAuditLog: { findMany: jest.Mock; count: jest.Mock };
  serviceAccountAuditLog: { findMany: jest.Mock; count: jest.Mock };
  dataExportLog: { findMany: jest.Mock; count: jest.Mock };
  user: { findMany: jest.Mock };
  serviceAccount: { findMany: jest.Mock };
  secretVault: { findMany: jest.Mock };
  secretItem: { findMany: jest.Mock };
}

function makePrisma(): FakePrisma {
  const emptyList = () => jest.fn().mockResolvedValue([]);
  return {
    // $transaction([findMany, count]) → run both (they are already resolved jest.fn promises).
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    secretAuditLog: {
      findMany: emptyList(),
      count: jest.fn().mockResolvedValue(0),
    },
    permissionAuditLog: {
      findMany: emptyList(),
      count: jest.fn().mockResolvedValue(0),
    },
    serviceAccountAuditLog: {
      findMany: emptyList(),
      count: jest.fn().mockResolvedValue(0),
    },
    dataExportLog: {
      findMany: emptyList(),
      count: jest.fn().mockResolvedValue(0),
    },
    user: { findMany: emptyList() },
    serviceAccount: { findMany: emptyList() },
    secretVault: { findMany: emptyList() },
    secretItem: { findMany: emptyList() },
  };
}

const svc = (p: FakePrisma) => new AuditService(p as unknown as PrismaService);

/** The file the engine streams for these filters, minus the limiter and the audit row. */
async function exportCsv(
  service: AuditService,
  filters: Parameters<AuditService['logsExport']>[0],
): Promise<string> {
  const { columns, fetchBatch } = service.logsExport(filters);
  let out = '';
  for await (const chunk of streamCsv({
    columns,
    batches: keysetBatches(fetchBatch),
  })) {
    out += chunk;
  }
  return out;
}
const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

/** The first arg of a mock's first call, typed to the Prisma findMany args we assert on. */
function firstArg(mock: jest.Mock): {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  select?: Record<string, boolean>;
} {
  const calls = mock.mock.calls as unknown as unknown[][];
  return calls[0]?.[0] as {
    where?: Record<string, unknown>;
    orderBy?: unknown;
    select?: Record<string, boolean>;
  };
}

describe('AuditService.getLogs — secret source (INV-10)', () => {
  it('resolves vault/item to metadata names, resolves a SA actor, and degrades a dangling ref to its id', async () => {
    const prisma = makePrisma();
    prisma.secretAuditLog.findMany.mockResolvedValue([
      {
        id: 2,
        action: 'ITEM_REVEALED',
        actorId: ACTOR,
        serviceAccountId: null,
        vaultId: 'v1',
        itemId: 'i1',
        targetUserId: TARGET,
        targetServiceAccountId: null,
        createdAt: new Date('2026-06-30T10:00:00.000Z'),
      },
      {
        id: 1,
        action: 'ITEMS_FETCHED',
        actorId: null,
        serviceAccountId: 'sa1',
        vaultId: 'vGone', // dangling — not returned by the vault lookup
        itemId: null,
        targetUserId: null,
        targetServiceAccountId: null,
        createdAt: new Date('2026-06-30T09:00:00.000Z'),
      },
    ]);
    prisma.secretAuditLog.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { id: ACTOR, firstName: 'Ada', lastName: 'Lovelace' },
      { id: TARGET, firstName: 'Grace', lastName: 'Hopper' },
    ]);
    prisma.serviceAccount.findMany.mockResolvedValue([
      { id: 'sa1', name: 'ci-bot', tokenPrefix: 'lzit_sa_ci' },
    ]);
    prisma.secretVault.findMany.mockResolvedValue([
      { id: 'v1', name: 'Prod DB' },
    ]);
    prisma.secretItem.findMany.mockResolvedValue([
      { id: 'i1', label: 'root pw' },
    ]);

    const page = await svc(prisma).getLogs({
      source: 'secret',
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);

    expect(page.total).toBe(2);
    const [reveal, fetch] = page.items;

    // Metadata resolved to display names — never a value.
    expect(reveal.vaultName).toBe('Prod DB');
    expect(reveal.itemLabel).toBe('root pw');
    expect(reveal.actorName).toBe('Ada Lovelace');
    expect(reveal.targetUserName).toBe('Grace Hopper');

    // SA actor → "name (prefix)"; a null human actor stays null.
    expect(fetch.serviceAccountName).toBe('ci-bot (lzit_sa_ci)');
    expect(fetch.actorName).toBeNull();
    // Dangling vault soft-ref → the raw id, not null, not a crash.
    expect(fetch.vaultName).toBe('vGone');

    // INV-10: the item lookup SELECTs the label only — never the ciphertext columns.
    const itemArgs = firstArg(prisma.secretItem.findMany);
    expect(itemArgs.select).toEqual({ id: true, label: true });
    expect(itemArgs.select).not.toHaveProperty('ciphertext');
    expect(itemArgs.select).not.toHaveProperty('iv');
    expect(itemArgs.select).not.toHaveProperty('authTag');
    // The wire rows carry no secret material at all.
    const wire = JSON.stringify(page.items);
    expect(wire).not.toContain('ciphertext');
    expect(wire).not.toContain('authTag');
  });

  it('applies the per-vault + action filters as an exact WHERE', async () => {
    const prisma = makePrisma();
    await svc(prisma).getLogs({
      source: 'secret',
      action: 'ITEM_REVEALED',
      vaultId: 'v1',
      itemId: 'i1',
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);

    const args = firstArg(prisma.secretAuditLog.findMany);
    expect(args.where).toMatchObject({
      action: 'ITEM_REVEALED',
      vaultId: 'v1',
      itemId: 'i1',
    });
    // Newest-first by the append-only id.
    expect(args.orderBy).toEqual({ id: 'desc' });
  });
});

describe('AuditService.getLogs — permission + serviceAccount sources', () => {
  it('reads a permission row (role + permission + direction)', async () => {
    const prisma = makePrisma();
    prisma.permissionAuditLog.findMany.mockResolvedValue([
      {
        id: 5,
        action: 'GRANT',
        actorId: ACTOR,
        role: 'MEMBER',
        permission: 'asset:read',
        createdAt: new Date('2026-06-30T08:00:00.000Z'),
      },
    ]);
    prisma.permissionAuditLog.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([
      { id: ACTOR, firstName: 'Ada', lastName: 'Lovelace' },
    ]);

    const page = await svc(prisma).getLogs({
      source: 'permission',
      action: 'GRANT',
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);

    expect(page.items[0]).toMatchObject({
      source: 'permission',
      action: 'GRANT',
      role: 'MEMBER',
      permission: 'asset:read',
      actorName: 'Ada Lovelace',
      vaultId: null,
    });
    expect(firstArg(prisma.permissionAuditLog.findMany).where).toMatchObject({
      action: 'GRANT',
    });
  });

  it('reads a service-account row and serializes the non-secret detail to a compact string', async () => {
    const prisma = makePrisma();
    prisma.serviceAccountAuditLog.findMany.mockResolvedValue([
      {
        id: 9,
        action: 'PERMISSION_CHANGE',
        actorId: ACTOR,
        serviceAccountId: 'sa2',
        detail: { added: ['asset:read'], removed: [] },
        createdAt: new Date('2026-06-30T07:00:00.000Z'),
      },
    ]);
    prisma.serviceAccountAuditLog.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([
      { id: ACTOR, firstName: 'Ada', lastName: 'Lovelace' },
    ]);
    prisma.serviceAccount.findMany.mockResolvedValue([
      { id: 'sa2', name: 'deploy', tokenPrefix: 'lzit_sa_dep' },
    ]);

    const page = await svc(prisma).getLogs({
      source: 'serviceAccount',
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);

    expect(page.items[0]).toMatchObject({
      source: 'serviceAccount',
      action: 'PERMISSION_CHANGE',
      serviceAccountName: 'deploy (lzit_sa_dep)',
      detail: JSON.stringify({ added: ['asset:read'], removed: [] }),
    });
  });
});

describe('AuditService — export source (DataExportLog, ADR-0103)', () => {
  it('reads an export row: the resource is the action, the row count and filters are the detail', async () => {
    const prisma = makePrisma();
    prisma.dataExportLog.findMany.mockResolvedValue([
      {
        id: 4,
        resource: 'USERS',
        actorId: null,
        serviceAccountId: 'sa3',
        filters: { role: 'VIEWER' },
        rowCount: 12,
        createdAt: new Date('2026-10-16T09:00:00.000Z'),
      },
    ]);
    prisma.dataExportLog.count.mockResolvedValue(1);
    prisma.serviceAccount.findMany.mockResolvedValue([
      { id: 'sa3', name: 'hr-sync', tokenPrefix: 'lzit_sa_hr' },
    ]);

    const page = await svc(prisma).getLogs({
      source: 'export',
      action: 'USERS',
      serviceAccountId: 'sa3',
      from: '2026-10-01T00:00:00.000Z',
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);

    expect(firstArg(prisma.dataExportLog.findMany).where).toEqual({
      resource: 'USERS',
      serviceAccountId: 'sa3',
      createdAt: { gte: new Date('2026-10-01T00:00:00.000Z') },
    });
    expect(firstArg(prisma.dataExportLog.findMany).orderBy).toEqual({
      id: 'desc',
    });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      source: 'export',
      action: 'USERS',
      actorId: null,
      serviceAccountName: 'hr-sync (lzit_sa_hr)',
      detail: JSON.stringify({ rowCount: 12, filters: { role: 'VIEWER' } }),
    });
    // The other sources are not read.
    expect(prisma.secretAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('offers the export actors in the actor menu', async () => {
    const prisma = makePrisma();
    prisma.dataExportLog.findMany.mockResolvedValue([{ actorId: ACTOR }]);
    prisma.user.findMany.mockResolvedValue([
      { id: ACTOR, firstName: 'Ada', lastName: 'Lovelace' },
    ]);

    await expect(svc(prisma).getFilterOptions('export')).resolves.toEqual({
      actors: [{ id: ACTOR, name: 'Ada Lovelace' }],
    });
  });

  it('streams export rows through the audit CSV columns with the keyset cursor', async () => {
    const prisma = makePrisma();
    prisma.dataExportLog.findMany.mockResolvedValueOnce([
      {
        id: 7,
        resource: 'ASSETS',
        actorId: null,
        serviceAccountId: null,
        filters: {},
        rowCount: 3,
        createdAt: new Date('2026-10-16T09:00:00.000Z'),
      },
    ]);

    const csv = await exportCsv(svc(prisma), { source: 'export' });

    expect(csv).toContain('2026-10-16T09:00:00.000Z,export,ASSETS,');
  });
});

describe('AuditController — export source', () => {
  function controller() {
    const getLogs = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const ctrl = new AuditController(
      { getLogs } as unknown as AuditService,
      {} as unknown as ExportService,
    );
    return { ctrl, getLogs };
  }

  it('accepts source=export with a resource as the action filter', async () => {
    const { ctrl, getLogs } = controller();
    await ctrl.logs('export', undefined, undefined, undefined, 'USERS');
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'export', action: 'USERS' }),
    );
  });

  it('rejects an action that is not an export resource, and the secret-only filters', async () => {
    const { ctrl, getLogs } = controller();
    await expect(
      ctrl.logs('export', undefined, undefined, undefined, 'GRANT'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctrl.logs(
        'export',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'v1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getLogs).not.toHaveBeenCalled();
  });
});

describe('AuditService.logsExport — export boundary (INV-10 + formula-injection guard)', () => {
  it('streams a header then metadata rows, defusing a formula-injection in a resolved vault name', async () => {
    const prisma = makePrisma();
    // A full batch then an empty one → proves the batching loop terminates.
    const row = {
      id: 1,
      action: 'ITEM_REVEALED',
      actorId: null,
      serviceAccountId: null,
      vaultId: 'v1',
      itemId: null,
      targetUserId: null,
      targetServiceAccountId: null,
      createdAt: new Date('2026-06-30T10:00:00.000Z'),
    };
    prisma.secretAuditLog.findMany
      .mockResolvedValueOnce(
        Array.from({ length: EXPORT_BATCH_SIZE }, () => row),
      )
      .mockResolvedValueOnce([]);
    // The vault is literally named with a spreadsheet formula → must be neutralized in the CSV.
    prisma.secretVault.findMany.mockResolvedValue([
      { id: 'v1', name: '=cmd|/c calc' },
    ]);

    const csv = await exportCsv(svc(prisma), { source: 'secret' });

    expect(prisma.secretAuditLog.findMany).toHaveBeenCalledTimes(2);
    // BOM then the header: no provenance stamp, nothing imports this file (ADR-0103 §8).
    expect(csv.startsWith(`\uFEFF${AUDIT_LOG_CSV_HEADER}\r\n`)).toBe(true);
    expect(AUDIT_LOG_CSV_HEADER).toBe(
      'occurredAt,source,action,actorName,serviceAccountName,vaultName,itemLabel,targetUserName,targetServiceAccountName,role,permission,detail',
    );
    // Formula-injection defused with a leading single quote.
    expect(csv).toContain("'=cmd|/c calc");
    // Every row of the full batch was serialized.
    expect(csv.split("'=cmd|/c calc").length - 1).toBe(EXPORT_BATCH_SIZE);
    // No value/ciphertext column exists in the export.
    expect(csv).not.toContain('ciphertext');
  });
});

describe('AuditService.logsExport — live table (AUD-033)', () => {
  it('emits every row exactly once while newer rows are appended mid-export', async () => {
    const prisma = makePrisma();
    const total = EXPORT_BATCH_SIZE * 2 + 5;
    let table = Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      action: 'ITEM_REVEALED',
      actorId: null,
      serviceAccountId: null,
      vaultId: null,
      itemId: `item-${i + 1}`,
      targetUserId: null,
      targetServiceAccountId: null,
      createdAt: new Date('2026-06-30T10:00:00.000Z'),
    }));
    // A newest-first table that grows by three rows after every batch read, honouring skip/take/id.lt.
    prisma.secretAuditLog.findMany.mockImplementation(
      (args: {
        where?: { id?: { lt: number } };
        take: number;
        skip?: number;
      }) => {
        const lt = args.where?.id?.lt ?? Infinity;
        const page = [...table]
          .sort((a, b) => b.id - a.id)
          .filter((r) => r.id < lt)
          .slice(args.skip ?? 0, (args.skip ?? 0) + args.take);
        const next = table.length + 1;
        table = table.concat(
          [0, 1, 2].map((k) => ({
            ...table[0],
            id: next + k,
            itemId: `item-${next + k}`,
          })),
        );
        return Promise.resolve(page);
      },
    );

    const csv = await exportCsv(svc(prisma), { source: 'secret' });

    const exported = csv.match(/item-\d+/g) ?? [];
    expect(new Set(exported).size).toBe(exported.length);
    expect(exported).toHaveLength(total);
  });
});

describe('AuditController — logs:read gate', () => {
  it('declares logs:read on every audit endpoint', () => {
    // Access via a cast record so referencing the handlers doesn't trip the unbound-method rule.
    const proto = AuditController.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const name of ['logs', 'export', 'filters']) {
      expect(Reflect.getMetadata(PERMISSION_KEY, proto[name])).toEqual([
        'logs:read',
      ]);
    }
  });
});
