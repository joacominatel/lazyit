import 'reflect-metadata';
import { AUDIT_LOG_CSV_HEADER } from '@lazyit/shared';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
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
    user: { findMany: emptyList() },
    serviceAccount: { findMany: emptyList() },
    secretVault: { findMany: emptyList() },
    secretItem: { findMany: emptyList() },
  };
}

const svc = (p: FakePrisma) => new AuditService(p as unknown as PrismaService);
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

describe('AuditService.streamLogsCsvRows — export boundary (INV-10 + formula-injection guard)', () => {
  async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of gen) out += chunk;
    return out;
  }

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
        Array.from({ length: AuditService.EXPORT_BATCH_SIZE }, () => row),
      )
      .mockResolvedValueOnce([]);
    // The vault is literally named with a spreadsheet formula → must be neutralized in the CSV.
    prisma.secretVault.findMany.mockResolvedValue([
      { id: 'v1', name: '=cmd|/c calc' },
    ]);

    const csv = await collect(
      svc(prisma).streamLogsCsvRows({ source: 'secret' } as never),
    );

    expect(prisma.secretAuditLog.findMany).toHaveBeenCalledTimes(2);
    expect(csv.startsWith(`${AUDIT_LOG_CSV_HEADER}\n`)).toBe(true);
    // Formula-injection defused with a leading single quote.
    expect(csv).toContain("'=cmd|/c calc");
    // Every row of the full batch was serialized.
    expect(csv.split("'=cmd|/c calc").length - 1).toBe(
      AuditService.EXPORT_BATCH_SIZE,
    );
    // No value/ciphertext column exists in the export.
    expect(csv).not.toContain('ciphertext');
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
