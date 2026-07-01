import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

// The service imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports jest
// can't resolve). The DB is faked here with an in-memory store, so stub the client/adapter.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { SecretManagerService } from './secret-manager.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/principal';
import type { ServiceAccount, User } from '../../generated/prisma/client';

// Programmatic secret retrieval via a service account (ADR-0080). A FOCUSED spec (its own minimal fake) for
// the SA crypto identity, the SA→vault grant, and the headless fetch. It PROVES INV-10 holds: the fetch
// response carries only ciphertext + wrapped keys (never a plaintext value / unwrapped key), and every
// programmatic read is audited (ITEMS_FETCHED with the SA as actor, no human).

// ── principals ──────────────────────────────────────────────────────────────────

function human(id: string, role: 'ADMIN' | 'MEMBER' = 'ADMIN'): Principal {
  return {
    kind: 'human',
    user: {
      id,
      role,
      firstName: 'First',
      lastName: 'Last',
      email: `${id}@x.test`,
    } as unknown as User,
  };
}

function service(id = 'sa1'): Principal {
  return {
    kind: 'service',
    serviceAccount: { id } as unknown as ServiceAccount,
    permissions: new Set(['secret:fetch']),
  };
}

// ── client-produced (already-encrypted) blob fixtures (base64) ────────────────────

const WRAP = {
  ephemeralPublicKey: 'ZXBoZW1lcmFsUHViS2V5',
  wrapNonce: 'd3JhcE5vbmNl',
  wrappedDek: 'd3JhcHBlZERlaw==',
  wrapVersion: 1,
};
const ENVELOPE = {
  ciphertext: 'Y2lwaGVydGV4dA==',
  iv: 'aXZpdml2aXY=',
  authTag: 'YXV0aFRhZ2F1dGhUYWc=',
  keyVersion: 1,
};
const KDF = {
  alg: 'argon2id' as const,
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
  v: 1,
};
const SA_KEYPAIR = {
  publicKey: 'c2FQdWJLZXk=',
  privateKeyEnc: 'c2FQcml2RW5j',
  privateKeySalt: 'c2FTYWx0',
  privateKeyIv: 'c2FJdg==',
  kdfParams: KDF,
};

// ── in-memory Prisma double (only what the SA methods call) ───────────────────────

interface AuditRow {
  action: string;
  actorId: string | null;
  serviceAccountId: string | null;
  vaultId: string | null;
  itemId: string | null;
  targetUserId: string | null;
  targetServiceAccountId: string | null;
}

class FakePrisma {
  vaults: {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }[] = [];
  items: {
    vaultId: string;
    handle: string;
    label: string;
    kind: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
    deletedAt: Date | null;
  }[] = [];
  humanMemberships: { vaultId: string; userId: string }[] = [];
  serviceAccounts: {
    id: string;
    deletedAt: Date | null;
    name?: string;
    description?: string | null;
    tokenPrefix?: string;
    isActive?: boolean;
  }[] = [];
  saKeypairs: {
    id: string;
    serviceAccountId: string;
    publicKey: string;
    privateKeyEnc: string;
    privateKeySalt: string;
    privateKeyIv: string;
    kdfParams: unknown;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }[] = [];
  saMemberships: {
    id: string;
    vaultId: string;
    serviceAccountId: string;
    ephemeralPublicKey: string;
    wrapNonce: string;
    wrappedDek: string;
    wrapVersion: number;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  audit: AuditRow[] = [];
  private seq = 0;
  private id(p: string): string {
    this.seq += 1;
    return `${p}${this.seq.toString().padStart(20, '0')}`;
  }

  readonly secretVault = {
    findFirst: ({ where }: { where: Record<string, unknown> }) => {
      const some = (
        where.serviceAccountMemberships as
          | { some?: { serviceAccountId?: string } }
          | undefined
      )?.some;
      return (
        this.vaults.find((v) => {
          if (v.deletedAt !== null) return false;
          if (typeof where.id === 'string' && v.id !== where.id) return false;
          if (
            some?.serviceAccountId &&
            !this.saMemberships.some(
              (m) =>
                m.vaultId === v.id &&
                m.serviceAccountId === some.serviceAccountId,
            )
          )
            return false;
          return true;
        }) ?? null
      );
    },
    findMany: ({ where }: { where?: Record<string, unknown> } = {}) => {
      const some = (
        where?.serviceAccountMemberships as
          | { some?: { serviceAccountId?: string } }
          | undefined
      )?.some;
      return this.vaults.filter((v) => {
        if (v.deletedAt !== null) return false;
        if (
          some?.serviceAccountId &&
          !this.saMemberships.some(
            (m) =>
              m.vaultId === v.id &&
              m.serviceAccountId === some.serviceAccountId,
          )
        )
          return false;
        return true;
      });
    },
  };

  readonly secretItem = {
    findMany: ({ where }: { where?: { vaultId?: string } } = {}) =>
      this.items.filter(
        (it) =>
          it.deletedAt === null &&
          (!where?.vaultId || it.vaultId === where.vaultId),
      ),
  };

  readonly vaultMembership = {
    findUnique: ({
      where,
    }: {
      where: { vaultId_userId: { vaultId: string; userId: string } };
    }) => {
      const { vaultId, userId } = where.vaultId_userId;
      return (
        this.humanMemberships.find(
          (m) => m.vaultId === vaultId && m.userId === userId,
        ) ?? null
      );
    },
  };

  readonly serviceAccount = {
    findFirst: ({ where }: { where: { id: string } }) =>
      this.serviceAccounts.find(
        (s) => s.id === where.id && s.deletedAt === null,
      ) ?? null,
  };

  readonly serviceAccountKeypair = {
    findFirst: ({
      where,
    }: {
      where: { serviceAccountId: string };
      select?: unknown;
    }) =>
      this.saKeypairs.find(
        (k) => k.serviceAccountId === where.serviceAccountId,
      ) ?? null,
    create: ({
      data,
    }: {
      data: {
        serviceAccountId: string;
        publicKey: string;
        privateKeyEnc: string;
        privateKeySalt: string;
        privateKeyIv: string;
        kdfParams: unknown;
      };
    }) => {
      const now = new Date();
      const row = {
        id: this.id('sakp'),
        ...data,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.saKeypairs.push(row);
      return row;
    },
    update: ({
      where,
      data,
    }: {
      where: { serviceAccountId: string };
      data: {
        publicKey: string;
        privateKeyEnc: string;
        privateKeySalt: string;
        privateKeyIv: string;
        kdfParams: unknown;
      };
    }) => {
      const row = this.saKeypairs.find(
        (k) => k.serviceAccountId === where.serviceAccountId,
      );
      if (!row) throw new Error('keypair not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  readonly serviceAccountVaultMembership = {
    findMany: ({ where }: { where: { vaultId: string }; orderBy?: unknown }) =>
      this.saMemberships
        .filter((m) => m.vaultId === where.vaultId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => {
          const sa = this.serviceAccounts.find(
            (s) => s.id === m.serviceAccountId,
          );
          return {
            serviceAccountId: m.serviceAccountId,
            createdAt: m.createdAt,
            serviceAccount: {
              name: sa?.name ?? 'SA',
              description: sa?.description ?? null,
              tokenPrefix: sa?.tokenPrefix ?? 'lzit_sa_x',
              isActive: sa?.isActive ?? true,
            },
          };
        }),
    findUnique: ({
      where,
    }: {
      where: {
        vaultId_serviceAccountId: { vaultId: string; serviceAccountId: string };
      };
    }) => {
      const { vaultId, serviceAccountId } = where.vaultId_serviceAccountId;
      return (
        this.saMemberships.find(
          (m) =>
            m.vaultId === vaultId && m.serviceAccountId === serviceAccountId,
        ) ?? null
      );
    },
    create: ({
      data,
    }: {
      data: {
        vaultId: string;
        serviceAccountId: string;
        ephemeralPublicKey: string;
        wrapNonce: string;
        wrappedDek: string;
        wrapVersion: number;
      };
    }) => {
      const now = new Date();
      const row = {
        id: this.id('sam'),
        ...data,
        createdAt: now,
        updatedAt: now,
      };
      this.saMemberships.push(row);
      return row;
    },
    delete: ({
      where,
    }: {
      where: {
        vaultId_serviceAccountId: { vaultId: string; serviceAccountId: string };
      };
    }) => {
      const { vaultId, serviceAccountId } = where.vaultId_serviceAccountId;
      const idx = this.saMemberships.findIndex(
        (m) => m.vaultId === vaultId && m.serviceAccountId === serviceAccountId,
      );
      if (idx === -1) throw new Error('membership not found');
      return this.saMemberships.splice(idx, 1)[0];
    },
    deleteMany: ({ where }: { where: { serviceAccountId: string } }) => {
      const before = this.saMemberships.length;
      this.saMemberships = this.saMemberships.filter(
        (m) => m.serviceAccountId !== where.serviceAccountId,
      );
      return { count: before - this.saMemberships.length };
    },
  };

  readonly secretAuditLog = {
    create: ({ data }: { data: AuditRow }) => {
      this.audit.push(data);
      return data;
    },
  };

  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> =>
    fn(this);
}

function build(): { svc: SecretManagerService; db: FakePrisma } {
  const db = new FakePrisma();
  const svc = new SecretManagerService(db as unknown as PrismaService);
  return { svc, db };
}

/** Seed a vault + a live human member + a service account (with a keypair unless `withKeypair=false`). */
function seed(
  db: FakePrisma,
  opts: { humanMemberId?: string; withKeypair?: boolean } = {},
): { vaultId: string; saId: string } {
  const vaultId = 'cvault1';
  const saId = 'sa1';
  db.vaults.push({
    id: vaultId,
    name: 'Prod',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
  db.serviceAccounts.push({ id: saId, deletedAt: null });
  if (opts.humanMemberId) {
    db.humanMemberships.push({ vaultId, userId: opts.humanMemberId });
  }
  if (opts.withKeypair !== false) {
    db.saKeypairs.push({
      id: 'sakp1',
      serviceAccountId: saId,
      ...SA_KEYPAIR,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
  }
  return { vaultId, saId };
}

describe('SecretManagerService — SA programmatic retrieval (ADR-0080)', () => {
  // ── set SA keypair (create on creation, replace on rotation) — #883 ─────────────
  describe('setServiceAccountKeypair', () => {
    it('stores the client-generated public + wrapped-private material and audits SA_KEYPAIR_CREATED', async () => {
      const { svc, db } = build();
      db.serviceAccounts.push({ id: 'sa1', deletedAt: null });
      const admin = human('admin');
      const kp = await svc.setServiceAccountKeypair(admin, 'sa1', SA_KEYPAIR);
      expect(kp.serviceAccountId).toBe('sa1');
      expect(kp.publicKey).toBe(SA_KEYPAIR.publicKey);
      expect(kp.privateKeyEnc).toBe(SA_KEYPAIR.privateKeyEnc);
      // INV-10: the wire shape carries no plaintext / token.
      expect(kp).not.toHaveProperty('token');
      expect(kp).not.toHaveProperty('privateKey');
      const row = db.audit.at(-1)!;
      expect(row.action).toBe('SA_KEYPAIR_CREATED');
      expect(row.actorId).toBe('admin');
      expect(row.targetServiceAccountId).toBe('sa1');
      expect(row.serviceAccountId).toBeNull();
    });

    it('404 if the service account is missing/revoked', async () => {
      const { svc } = build();
      await expect(
        svc.setServiceAccountKeypair(human('admin'), 'ghost', SA_KEYPAIR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('REPLACES an existing keypair in place (rotation retrofit) and re-audits SA_KEYPAIR_CREATED', async () => {
      const { svc, db } = build();
      seed(db, { withKeypair: true });
      const rotated = { ...SA_KEYPAIR, publicKey: 'cm90YXRlZFB1Yg==' };
      const kp = await svc.setServiceAccountKeypair(
        human('admin'),
        'sa1',
        rotated,
      );
      // One keypair row, now carrying the NEW public key — never a second row (1:1 @unique).
      expect(db.saKeypairs).toHaveLength(1);
      expect(kp.publicKey).toBe('cm90YXRlZFB1Yg==');
      expect(db.audit.at(-1)!.action).toBe('SA_KEYPAIR_CREATED');
    });

    it('DROPS the SA vault grants when the regenerated keypair has a new public key (must re-grant)', async () => {
      const { svc, db } = build();
      const { vaultId, saId } = seed(db, { withKeypair: true });
      db.saMemberships.push({
        id: 'sam1',
        vaultId,
        serviceAccountId: saId,
        ...WRAP,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await svc.setServiceAccountKeypair(human('admin'), saId, {
        ...SA_KEYPAIR,
        publicKey: 'cm90YXRlZFB1Yg==',
      });
      // The old DEK was wrapped to the old public key — now undecryptable, so the membership is hard-dropped.
      expect(db.saMemberships).toHaveLength(0);
    });

    it('KEEPS the SA vault grants on an idempotent re-upload of the SAME public key', async () => {
      const { svc, db } = build();
      const { vaultId, saId } = seed(db, { withKeypair: true });
      db.saMemberships.push({
        id: 'sam1',
        vaultId,
        serviceAccountId: saId,
        ...WRAP,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await svc.setServiceAccountKeypair(human('admin'), saId, SA_KEYPAIR);
      expect(db.saMemberships).toHaveLength(1);
    });

    it('403 if the caller is a service account (human-only)', async () => {
      const { svc, db } = build();
      db.serviceAccounts.push({ id: 'sa1', deletedAt: null });
      await expect(
        svc.setServiceAccountKeypair(service(), 'sa1', SA_KEYPAIR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── SA public key ─────────────────────────────────────────────────────────────
  describe('getServiceAccountPublicKey', () => {
    it('returns ONLY the public key + id, never a wrapped private key', async () => {
      const { svc, db } = build();
      seed(db, { withKeypair: true });
      const pk = await svc.getServiceAccountPublicKey('sa1');
      expect(pk).toEqual({
        serviceAccountId: 'sa1',
        publicKey: SA_KEYPAIR.publicKey,
      });
      expect(pk).not.toHaveProperty('privateKeyEnc');
    });

    it('404 if the SA has no keypair', async () => {
      const { svc, db } = build();
      seed(db, { withKeypair: false });
      await expect(
        svc.getServiceAccountPublicKey('sa1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── grant SA membership (no-grant-what-you-cant-read) ─────────────────────────
  describe('grantServiceAccountMembership', () => {
    const grant = {
      serviceAccountId: 'sa1',
      ephemeralPublicKey: WRAP.ephemeralPublicKey,
      wrapNonce: WRAP.wrapNonce,
      wrappedDek: WRAP.wrappedDek,
      wrapVersion: 1,
    };

    it('a live human member can grant an SA; audits MEMBERSHIP_GRANTED with the SA target', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      const row = await svc.grantServiceAccountMembership(
        human('alice'),
        vaultId,
        grant,
      );
      expect(row.serviceAccountId).toBe('sa1');
      expect(row.wrappedDek).toBe(WRAP.wrappedDek);
      const a = db.audit.at(-1)!;
      expect(a.action).toBe('MEMBERSHIP_GRANTED');
      expect(a.actorId).toBe('alice');
      expect(a.targetServiceAccountId).toBe('sa1');
      expect(a.targetUserId).toBeNull();
    });

    it('403 if the granter is NOT a live member (no-grant-what-you-cant-read)', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, {}); // no human membership seeded
      await expect(
        svc.grantServiceAccountMembership(human('mallory'), vaultId, grant),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 if the target service account does not exist', async () => {
      const { svc, db } = build();
      const vaultId = 'cvault1';
      db.vaults.push({
        id: vaultId,
        name: 'Prod',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      db.humanMemberships.push({ vaultId, userId: 'alice' });
      await expect(
        svc.grantServiceAccountMembership(human('alice'), vaultId, grant),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 if the SA is already a member', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      await svc.grantServiceAccountMembership(human('alice'), vaultId, grant);
      await expect(
        svc.grantServiceAccountMembership(human('alice'), vaultId, grant),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── revoke SA membership ──────────────────────────────────────────────────────
  describe('revokeServiceAccountMembership', () => {
    it('hard-drops the row and audits MEMBERSHIP_REVOKED', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      db.saMemberships.push({
        id: 'sam1',
        vaultId,
        serviceAccountId: 'sa1',
        ...WRAP,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await svc.revokeServiceAccountMembership(
        human('alice'),
        vaultId,
        'sa1',
      );
      expect(res).toEqual({ revoked: true });
      expect(db.saMemberships).toHaveLength(0);
      expect(db.audit.at(-1)!.action).toBe('MEMBERSHIP_REVOKED');
      expect(db.audit.at(-1)!.targetServiceAccountId).toBe('sa1');
    });

    it('404 if the SA is not a member', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      await expect(
        svc.revokeServiceAccountMembership(human('alice'), vaultId, 'sa1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── list SA members (#888 — SA members were invisible in the vault Members UI) ───
  describe('listServiceAccountMembers', () => {
    it('returns granted SA members with non-secret display metadata', async () => {
      const { svc, db } = build();
      const { vaultId, saId } = seed(db, { humanMemberId: 'alice' });
      Object.assign(db.serviceAccounts.find((s) => s.id === saId)!, {
        name: 'CI Runner',
        description: 'nightly deploy',
        tokenPrefix: 'lzit_sa_ci',
        isActive: true,
      });
      await svc.grantServiceAccountMembership(human('alice'), vaultId, {
        serviceAccountId: saId,
        ...WRAP,
      });

      const members = await svc.listServiceAccountMembers(
        human('alice'),
        vaultId,
      );
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({
        serviceAccountId: saId,
        name: 'CI Runner',
        description: 'nightly deploy',
        tokenPrefix: 'lzit_sa_ci',
        isActive: true,
      });
      // INV-10: the metadata read never leaks the wrapped DEK blob.
      expect(JSON.stringify(members)).not.toContain(WRAP.wrappedDek);
    });

    it('is empty when no service account has been granted', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      expect(
        await svc.listServiceAccountMembers(human('alice'), vaultId),
      ).toEqual([]);
    });

    it('403s a human who is neither ADMIN nor a live member', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { humanMemberId: 'alice' });
      await expect(
        svc.listServiceAccountMembers(human('mallory', 'MEMBER'), vaultId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── headless fetch (INV-10 heart) ─────────────────────────────────────────────
  describe('fetchVaultForServiceAccount', () => {
    function seedFetchable(db: FakePrisma): string {
      const { vaultId } = seed(db, { withKeypair: true });
      db.saMemberships.push({
        id: 'sam1',
        vaultId,
        serviceAccountId: 'sa1',
        ...WRAP,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      db.items.push({
        vaultId,
        handle: 'prod-db-password',
        label: 'Prod DB password',
        kind: 'GENERIC',
        ...ENVELOPE,
        deletedAt: null,
      });
      return vaultId;
    }

    it('returns ONLY ciphertext + wrapped keys (no plaintext), and audits ITEMS_FETCHED (SA actor, no human)', async () => {
      const { svc, db } = build();
      const vaultId = seedFetchable(db);
      const res = await svc.fetchVaultForServiceAccount(
        service('sa1'),
        vaultId,
      );

      // Wrapped keypair + wrapped DEK + item ciphertext — no plaintext / unwrapped key anywhere.
      expect(res.keypair.privateKeyEnc).toBe(SA_KEYPAIR.privateKeyEnc);
      expect(res.keypair).not.toHaveProperty('publicKey'); // CLI doesn't need it
      expect(res.membership.wrappedDek).toBe(WRAP.wrappedDek);
      expect(res.membership).not.toHaveProperty('dek');
      expect(res.items).toHaveLength(1);
      expect(res.items[0].ciphertext).toBe(ENVELOPE.ciphertext);
      expect(res.items[0]).not.toHaveProperty('value');
      // deep scan: no field named value/plaintext/privateKey/dek in the whole response
      const json = JSON.stringify(res);
      for (const banned of [
        '"value"',
        '"plaintext"',
        '"privateKey"',
        '"dek"',
      ]) {
        expect(json.includes(banned)).toBe(false);
      }

      // Every programmatic read is audited: SA is the actor (serviceAccountId), never a human (actorId null).
      const a = db.audit.at(-1)!;
      expect(a.action).toBe('ITEMS_FETCHED');
      expect(a.serviceAccountId).toBe('sa1');
      expect(a.actorId).toBeNull();
      expect(a.vaultId).toBe(vaultId);
    });

    it('403 if the caller is a HUMAN (service-only), even an ADMIN', async () => {
      const { svc, db } = build();
      const vaultId = seedFetchable(db);
      await expect(
        svc.fetchVaultForServiceAccount(human('admin', 'ADMIN'), vaultId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403 if the SA is NOT a member of the vault', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { withKeypair: true }); // SA exists + keypair, but no membership
      await expect(
        svc.fetchVaultForServiceAccount(service('sa1'), vaultId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 if the vault does not exist', async () => {
      const { svc } = build();
      await expect(
        svc.fetchVaultForServiceAccount(service('sa1'), 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── list fetchable vaults ─────────────────────────────────────────────────────
  describe('listFetchableVaults', () => {
    it('lists only the vaults the SA is a member of (metadata only); 403 for a human', async () => {
      const { svc, db } = build();
      const { vaultId } = seed(db, { withKeypair: true });
      db.saMemberships.push({
        id: 'sam1',
        vaultId,
        serviceAccountId: 'sa1',
        ...WRAP,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const list = await svc.listFetchableVaults(service('sa1'));
      expect(list.map((v) => v.id)).toEqual([vaultId]);
      await expect(
        svc.listFetchableVaults(human('admin')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
