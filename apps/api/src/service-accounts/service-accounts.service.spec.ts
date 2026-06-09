import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EngineServiceAccountService } from '../workflow-engine/engine-service-account.service';

// The service imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports jest
// can't resolve). The DB is faked here with an in-memory store, so stub the client/adapter.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { ServiceAccountsService } from './service-accounts.service';
import { hashSecret, parseToken } from './service-account-token';
import type { PrismaService } from '../prisma/prisma.service';

interface SaRow {
  id: string;
  name: string;
  description: string | null;
  tokenHash: string;
  tokenPrefix: string;
  isActive: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface PermRow {
  serviceAccountId: string;
  permission: string;
}
interface AuditRow {
  serviceAccountId: string;
  action: string;
  actorId: string | null;
  detail?: unknown;
}

/**
 * An in-memory Prisma double backing serviceAccount + serviceAccountPermission + serviceAccountAuditLog.
 * Just enough for the service: create/update/findFirst/findFirstOrThrow/findMany with a WITH_PERMISSIONS
 * include, the join's findMany/createMany/deleteMany, and the audit createMany. `$transaction` runs the
 * callback against the SAME store so the full create/update/rotate/revoke chain is exercised without a DB.
 * The read filter (`deletedAt: null`) is honored manually (the soft-delete extension is bypassed here).
 */
class FakePrisma {
  accounts: SaRow[] = [];
  perms: PermRow[] = [];
  audit: AuditRow[] = [];
  private seq = 0;

  private newId(): string {
    // cuid-like: lowercase alnum, NO underscores (a real cuid never contains one, which matters because
    // the token format splits id/secret on the first underscore after the lzit_sa_ prefix).
    this.seq += 1;
    return `cfake${this.seq.toString().padStart(20, '0')}`;
  }

  private withPerms(row: SaRow) {
    return {
      ...row,
      permissions: this.perms
        .filter((p) => p.serviceAccountId === row.id)
        .map((p) => ({ permission: p.permission })),
    };
  }

  private readonly client = {
    serviceAccount: {
      create: ({
        data,
      }: {
        data: Record<string, unknown>;
        include?: unknown;
      }) => {
        const now = new Date();
        const row: SaRow = {
          id: this.newId(),
          name: data.name as string,
          description: (data.description as string | null) ?? null,
          tokenHash: data.tokenHash as string,
          tokenPrefix: data.tokenPrefix as string,
          isActive: true,
          expiresAt: (data.expiresAt as Date | null) ?? null,
          lastUsedAt: null,
          createdById: (data.createdById as string | null) ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        this.accounts.push(row);
        const nested = data.permissions as
          | { create: { permission: string }[] }
          | undefined;
        if (nested) {
          for (const p of nested.create) {
            this.perms.push({
              serviceAccountId: row.id,
              permission: p.permission,
            });
          }
        }
        return Promise.resolve(this.withPerms(row));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
        include?: unknown;
      }) => {
        const row = this.accounts.find((a) => a.id === where.id);
        if (!row) return Promise.reject(new Error('not found'));
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve(this.withPerms(row));
      },
      findFirst: ({
        where,
        includeSoftDeleted,
      }: {
        where: { id: string };
        includeSoftDeleted?: boolean;
      }) => {
        const row = this.accounts.find(
          (a) =>
            a.id === where.id &&
            (includeSoftDeleted === true || a.deletedAt === null),
        );
        return Promise.resolve(row ? this.withPerms(row) : null);
      },
      findFirstOrThrow: ({ where }: { where: { id: string } }) => {
        const row = this.accounts.find(
          (a) => a.id === where.id && a.deletedAt === null,
        );
        if (!row) return Promise.reject(new Error('not found'));
        return Promise.resolve(this.withPerms(row));
      },
      findMany: ({
        includeSoftDeleted,
      }: {
        includeSoftDeleted?: boolean;
      } = {}) =>
        Promise.resolve(
          this.accounts
            .filter((a) => includeSoftDeleted === true || a.deletedAt === null)
            .map((a) => this.withPerms(a)),
        ),
    },
    serviceAccountPermission: {
      findMany: ({ where }: { where: { serviceAccountId: string } }) =>
        Promise.resolve(
          this.perms
            .filter((p) => p.serviceAccountId === where.serviceAccountId)
            .map((p) => ({ permission: p.permission })),
        ),
      createMany: ({ data }: { data: PermRow[] }) => {
        this.perms.push(...data);
        return Promise.resolve({ count: data.length });
      },
      deleteMany: ({
        where,
      }: {
        where: { serviceAccountId: string; permission: { in: string[] } };
      }) => {
        const drop = new Set(where.permission.in);
        this.perms = this.perms.filter(
          (p) =>
            !(
              p.serviceAccountId === where.serviceAccountId &&
              drop.has(p.permission)
            ),
        );
        return Promise.resolve({ count: drop.size });
      },
    },
    serviceAccountAuditLog: {
      create: ({ data }: { data: AuditRow }) => {
        this.audit.push(data);
        return Promise.resolve({ id: this.audit.length, ...data });
      },
    },
  };

  get serviceAccount() {
    return this.client.serviceAccount;
  }
  get serviceAccountPermission() {
    return this.client.serviceAccountPermission;
  }
  get serviceAccountAuditLog() {
    return this.client.serviceAccountAuditLog;
  }

  $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

describe('ServiceAccountsService (ADR-0048)', () => {
  let prisma: FakePrisma;
  let service: ServiceAccountsService;
  const ADMIN = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new ServiceAccountsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('returns the full token ONCE, persists only its hash, and audits MINT', async () => {
      const res = await service.create(
        { name: 'ci-runner', permissions: ['asset:read', 'asset:write'] },
        ADMIN,
      );

      // The cleartext token is returned and embeds the row id.
      expect(res.token.startsWith(`lzit_sa_${res.id}_`)).toBe(true);
      expect(res.permissions).toEqual(['asset:read', 'asset:write']);
      expect(res.createdById).toBe(ADMIN);

      // The stored row holds only the HASH of the secret — never the cleartext.
      const stored = prisma.accounts.find((a) => a.id === res.id)!;
      const { secret } = parseToken(res.token)!;
      expect(stored.tokenHash).toBe(hashSecret(secret));
      expect(stored.tokenHash).not.toContain(secret);

      // Audited as MINT by the acting admin.
      expect(prisma.audit).toContainEqual(
        expect.objectContaining({
          serviceAccountId: res.id,
          action: 'MINT',
          actorId: ADMIN,
        }),
      );
    });

    it('the wire entity read (findOne) never carries the token/secret', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      const read = await service.findOne(created.id);
      expect(read).not.toHaveProperty('token');
      expect(read).not.toHaveProperty('tokenHash');
      expect(read.tokenPrefix).toBeTruthy();
    });

    it('rejects a past expiresAt (400)', async () => {
      await expect(
        service.create(
          {
            name: 'x',
            permissions: ['asset:read'],
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rotate', () => {
    it('mints a NEW secret, invalidates the old, returns it once, and audits ROTATE', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      const oldHash = prisma.accounts.find(
        (a) => a.id === created.id,
      )!.tokenHash;

      const rotated = await service.rotate(created.id, ADMIN);

      // A different cleartext token (same id segment), and the stored hash changed.
      expect(rotated.token).not.toBe(created.token);
      expect(rotated.token.startsWith(`lzit_sa_${created.id}_`)).toBe(true);
      const newHash = prisma.accounts.find(
        (a) => a.id === created.id,
      )!.tokenHash;
      expect(newHash).not.toBe(oldHash);
      // The OLD secret no longer hashes to the stored hash → it can never authenticate again.
      const oldSecret = parseToken(created.token)!.secret;
      expect(hashSecret(oldSecret)).not.toBe(newHash);

      expect(prisma.audit).toContainEqual(
        expect.objectContaining({ action: 'ROTATE', actorId: ADMIN }),
      );
    });

    it('404s rotating an unknown id', async () => {
      await expect(service.rotate('sa_missing', ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('replaces the grant set and audits PERMISSION_CHANGE with the diff', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read', 'asset:write'] },
        ADMIN,
      );
      const updated = await service.update(
        created.id,
        { permissions: ['asset:read', 'asset:delete'] },
        ADMIN,
      );
      expect(updated.permissions).toEqual(['asset:read', 'asset:delete']);
      expect(prisma.audit).toContainEqual(
        expect.objectContaining({
          action: 'PERMISSION_CHANGE',
          detail: { added: ['asset:delete'], removed: ['asset:write'] },
        }),
      );
    });

    it('does NOT audit a PERMISSION_CHANGE when only the name changed', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      prisma.audit = [];
      const updated = await service.update(
        created.id,
        { name: 'renamed' },
        ADMIN,
      );
      expect(updated.name).toBe('renamed');
      expect(prisma.audit.some((a) => a.action === 'PERMISSION_CHANGE')).toBe(
        false,
      );
    });

    it('toggles isActive (soft disable, distinct from revoke)', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      const updated = await service.update(
        created.id,
        { isActive: false },
        ADMIN,
      );
      expect(updated.isActive).toBe(false);
      expect(updated.deletedAt).toBeNull(); // still live, just disabled
    });
  });

  describe('revoke / restore', () => {
    it('revoke soft-deletes (deletedAt set) and audits REVOKE; the row is then hidden from findOne', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      const revoked = await service.revoke(created.id, ADMIN);
      expect(revoked.deletedAt).not.toBeNull();
      expect(prisma.audit).toContainEqual(
        expect.objectContaining({ action: 'REVOKE' }),
      );
      // findOne uses the read filter → a revoked account is a 404.
      await expect(service.findOne(created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('restore clears deletedAt and audits RESTORE', async () => {
      const created = await service.create(
        { name: 'x', permissions: ['asset:read'] },
        ADMIN,
      );
      await service.revoke(created.id, ADMIN);
      const restored = await service.restore(created.id, ADMIN);
      expect(restored.deletedAt).toBeNull();
      expect(prisma.audit).toContainEqual(
        expect.objectContaining({ action: 'RESTORE' }),
      );
    });

    it('findAll hides revoked by default, includeRevoked shows them', async () => {
      const a = await service.create(
        { name: 'a', permissions: ['asset:read'] },
        ADMIN,
      );
      await service.create({ name: 'b', permissions: ['asset:read'] }, ADMIN);
      await service.revoke(a.id, ADMIN);

      const live = await service.findAll();
      expect(live.map((x) => x.name).sort()).toEqual(['b']);

      const all = await service.findAll(true);
      expect(all.map((x) => x.name).sort()).toEqual(['a', 'b']);
    });
  });

  // The auto-provisioned engine SA (#304) — the singleton a workflow run executes as — is system-managed:
  // a human can never edit / disable / rotate / revoke it. It is identified by the RESERVED NAME, so we
  // create a row and rename it to that reserved literal to exercise the lock.
  describe('system-managed engine SA (#304)', () => {
    async function seedEngineSa(): Promise<string> {
      const created = await service.create(
        { name: 'placeholder', permissions: ['asset:read'] },
        ADMIN,
      );
      // Rename the row to the reserved engine name so the lock recognises it.
      prisma.accounts.find((a) => a.id === created.id)!.name =
        EngineServiceAccountService.ENGINE_SA_NAME;
      return created.id;
    }

    it('marks the engine SA systemManaged:true on reads (so the UI can gate)', async () => {
      const id = await seedEngineSa();
      const read = await service.findOne(id);
      expect(read.systemManaged).toBe(true);
    });

    it('a normal account is systemManaged:false', async () => {
      const created = await service.create(
        { name: 'ci-runner', permissions: ['asset:read'] },
        ADMIN,
      );
      const read = await service.findOne(created.id);
      expect(read.systemManaged).toBe(false);
    });

    it('rejects edit (update) of the engine SA with a 409 and does not mutate it', async () => {
      const id = await seedEngineSa();
      await expect(
        service.update(id, { name: 'hijacked' }, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
      // Untouched: still the reserved name.
      expect(prisma.accounts.find((a) => a.id === id)!.name).toBe(
        EngineServiceAccountService.ENGINE_SA_NAME,
      );
    });

    it('rejects disable (isActive=false) of the engine SA with a 409', async () => {
      const id = await seedEngineSa();
      await expect(
        service.update(id, { isActive: false }, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.accounts.find((a) => a.id === id)!.isActive).toBe(true);
    });

    it('rejects rotate of the engine SA with a 409', async () => {
      const id = await seedEngineSa();
      const hashBefore = prisma.accounts.find((a) => a.id === id)!.tokenHash;
      await expect(service.rotate(id, ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The throwaway token hash is untouched.
      expect(prisma.accounts.find((a) => a.id === id)!.tokenHash).toBe(
        hashBefore,
      );
    });

    it('rejects revoke (soft-delete) of the engine SA with a 409', async () => {
      const id = await seedEngineSa();
      await expect(service.revoke(id, ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Still live — it must always exist as the run actor.
      expect(prisma.accounts.find((a) => a.id === id)!.deletedAt).toBeNull();
    });

    it('leaves a normal account fully mutable (update/rotate/revoke unaffected)', async () => {
      const created = await service.create(
        { name: 'ci-runner', permissions: ['asset:read'] },
        ADMIN,
      );
      await expect(
        service.update(created.id, { name: 'renamed' }, ADMIN),
      ).resolves.toMatchObject({ name: 'renamed' });
      await expect(service.rotate(created.id, ADMIN)).resolves.toHaveProperty(
        'token',
      );
      await expect(service.revoke(created.id, ADMIN)).resolves.toHaveProperty(
        'deletedAt',
      );
    });
  });
});
