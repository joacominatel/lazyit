import {
  BadRequestException,
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

// ── principals ──────────────────────────────────────────────────────────────────

function human(
  id: string,
  role: 'ADMIN' | 'MEMBER' | 'VIEWER' = 'MEMBER',
): Principal {
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

function serviceAccount(): Principal {
  return {
    kind: 'service',
    serviceAccount: { id: 'sa1' } as unknown as ServiceAccount,
    permissions: new Set(['secret:read', 'secret:manage']),
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
const KEYPAIR = {
  publicKey: 'cHViS2V5',
  privateKeyEncByPassphrase: 'cHJpdkVuY1Bhc3M=',
  passphraseSalt: 'c2FsdA==',
  passphraseIv: 'aXYx',
  kdfParams: {
    alg: 'argon2id' as const,
    memorySize: 65536,
    iterations: 3,
    parallelism: 1,
    saltLength: 16,
    hashLength: 32,
    v: 1,
  },
  privateKeyEncByRecovery: 'cHJpdkVuY1JlYw==',
  recoverySalt: 'c2FsdDI=',
  recoveryIv: 'aXYy',
};

// ── in-memory Prisma double ───────────────────────────────────────────────────────

interface VaultRow {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface ItemRow {
  id: string;
  vaultId: string;
  handle: string;
  label: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface MembershipRow {
  id: string;
  vaultId: string;
  userId: string;
  ephemeralPublicKey: string;
  wrapNonce: string;
  wrappedDek: string;
  wrapVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
interface KeypairRow {
  id: string;
  userId: string;
  publicKey: string;
  privateKeyEncByPassphrase: string;
  passphraseSalt: string;
  passphraseIv: string;
  kdfParams: unknown;
  privateKeyEncByRecovery: string;
  recoverySalt: string;
  recoveryIv: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface AuditRow {
  action: string;
  actorId: string | null;
  vaultId: string | null;
  itemId: string | null;
  targetUserId: string | null;
}

/**
 * An in-memory Prisma double for SecretManagerService. Implements ONLY the operations the service calls.
 * It honors the LIVE-row read filter manually (the soft-delete extension is bypassed under jest), and
 * the live-only partial-unique on vault.name / item.handle so soft-delete-reuse can be asserted.
 */
class FakePrisma {
  vaults: VaultRow[] = [];
  items: ItemRow[] = [];
  memberships: MembershipRow[] = [];
  keypairs: KeypairRow[] = [];
  audit: AuditRow[] = [];
  users: { id: string; firstName: string; lastName: string; email: string }[] =
    [];
  private seq = 0;

  private newId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString().padStart(20, '0')}`;
  }

  // -- secretVault --------------------------------------------------------------
  readonly secretVault = {
    findFirst: ({ where }: { where: Record<string, unknown> }) => {
      const includeDeleted = (where as { includeSoftDeleted?: boolean })
        .includeSoftDeleted;
      return (
        this.vaults.find((v) => this.matchVault(v, where, includeDeleted)) ??
        null
      );
    },
    findMany: ({
      where,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
    } = {}) =>
      this.vaults.filter((v) => this.matchVault(v, where ?? {}, false)),
    create: ({ data }: { data: { name: string } }) => {
      const now = new Date();
      const row: VaultRow = {
        id: this.newId('cvault'),
        name: data.name,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.vaults.push(row);
      return row;
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<VaultRow>;
    }) => {
      const row = this.vaults.find((v) => v.id === where.id);
      if (!row) throw new Error('vault not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  private matchVault(
    v: VaultRow,
    where: Record<string, unknown>,
    includeDeleted?: boolean,
  ): boolean {
    if (!includeDeleted && v.deletedAt !== null) return false;
    if (typeof where.id === 'string' && v.id !== where.id) return false;
    if (typeof where.name === 'string' && v.name !== where.name) return false;
    const idNot = (where.id as { not?: string } | undefined)?.not;
    if (idNot && v.id === idNot) return false;
    const mship = (
      where.memberships as { some?: { userId?: string } } | undefined
    )?.some;
    if (mship?.userId) {
      const isMember = this.memberships.some(
        (m) => m.vaultId === v.id && m.userId === mship.userId,
      );
      if (!isMember) return false;
    }
    return true;
  }

  // -- secretItem ---------------------------------------------------------------
  readonly secretItem = {
    findFirst: ({ where }: { where: Record<string, unknown> }) =>
      this.items.find((it) => this.matchItem(it, where)) ?? null,
    findMany: ({ where }: { where?: Record<string, unknown> } = {}) =>
      this.items.filter((it) => this.matchItem(it, where ?? {})),
    create: ({
      data,
    }: {
      data: Omit<ItemRow, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
    }) => {
      const now = new Date();
      const row: ItemRow = {
        id: this.newId('citem'),
        ...data,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.items.push(row);
      return row;
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<ItemRow>;
    }) => {
      const row = this.items.find((it) => it.id === where.id);
      if (!row) throw new Error('item not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: ({
      where,
      data,
    }: {
      where: { vaultId: string; deletedAt: null };
      data: Partial<ItemRow>;
    }) => {
      let count = 0;
      for (const it of this.items) {
        if (it.vaultId === where.vaultId && it.deletedAt === null) {
          Object.assign(it, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
  };

  private matchItem(it: ItemRow, where: Record<string, unknown>): boolean {
    // No includeSoftDeleted path used by the service for items → always live-only.
    if (it.deletedAt !== null) return false;
    if (typeof where.id === 'string' && it.id !== where.id) return false;
    const idNot = (where.id as { not?: string } | undefined)?.not;
    if (idNot && it.id === idNot) return false;
    if (typeof where.vaultId === 'string' && it.vaultId !== where.vaultId)
      return false;
    if (typeof where.handle === 'string' && it.handle !== where.handle)
      return false;
    const vaultMembers = (
      where.vault as
        | { memberships?: { some?: { userId?: string } } }
        | undefined
    )?.memberships?.some;
    if (vaultMembers?.userId) {
      const isMember = this.memberships.some(
        (m) => m.vaultId === it.vaultId && m.userId === vaultMembers.userId,
      );
      if (!isMember) return false;
    }
    if (Array.isArray(where.OR)) {
      const ors = where.OR as {
        handle?: { contains?: string };
        label?: { contains?: string };
      }[];
      const match = ors.some((o) => {
        const h = o.handle?.contains;
        const l = o.label?.contains;
        return (
          (h !== undefined &&
            it.handle.toLowerCase().includes(h.toLowerCase())) ||
          (l !== undefined && it.label.toLowerCase().includes(l.toLowerCase()))
        );
      });
      if (!match) return false;
    }
    return true;
  }

  // -- vaultMembership ----------------------------------------------------------
  readonly vaultMembership = {
    findUnique: ({
      where,
    }: {
      where: { vaultId_userId: { vaultId: string; userId: string } };
    }) => {
      const { vaultId, userId } = where.vaultId_userId;
      return (
        this.memberships.find(
          (m) => m.vaultId === vaultId && m.userId === userId,
        ) ?? null
      );
    },
    findMany: ({ where }: { where: { vaultId: string }; select?: unknown }) => {
      return this.memberships
        .filter((m) => m.vaultId === where.vaultId)
        .map((m) => ({
          userId: m.userId,
          createdAt: m.createdAt,
          user: this.users.find((u) => u.id === m.userId) ?? {
            firstName: 'First',
            lastName: 'Last',
            email: `${m.userId}@x.test`,
          },
        }));
    },
    create: ({
      data,
    }: {
      data: Omit<MembershipRow, 'id' | 'createdAt' | 'updatedAt'>;
    }) => {
      const now = new Date();
      const row: MembershipRow = {
        id: this.newId('cmem'),
        ...data,
        createdAt: now,
        updatedAt: now,
      };
      this.memberships.push(row);
      return row;
    },
    delete: ({
      where,
    }: {
      where: { vaultId_userId: { vaultId: string; userId: string } };
    }) => {
      const { vaultId, userId } = where.vaultId_userId;
      const idx = this.memberships.findIndex(
        (m) => m.vaultId === vaultId && m.userId === userId,
      );
      if (idx === -1) throw new Error('membership not found');
      return this.memberships.splice(idx, 1)[0];
    },
    deleteMany: ({ where }: { where: { vaultId: string } }) => {
      const before = this.memberships.length;
      this.memberships = this.memberships.filter(
        (m) => m.vaultId !== where.vaultId,
      );
      return { count: before - this.memberships.length };
    },
  };

  // -- userKeypair --------------------------------------------------------------
  readonly userKeypair = {
    findFirst: ({ where }: { where: { userId: string }; select?: unknown }) =>
      this.keypairs.find(
        (k) => k.userId === where.userId && k.deletedAt === null,
      ) ?? null,
    create: ({
      data,
    }: {
      data: Omit<KeypairRow, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
    }) => {
      const now = new Date();
      const row: KeypairRow = {
        id: this.newId('ckp'),
        ...data,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.keypairs.push(row);
      return row;
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { userId: string };
      create: Omit<KeypairRow, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
      update: Partial<KeypairRow>;
    }) => {
      const existing = this.keypairs.find((k) => k.userId === where.userId);
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const now = new Date();
      const row: KeypairRow = {
        id: this.newId('ckp'),
        ...create,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.keypairs.push(row);
      return row;
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<KeypairRow>;
    }) => {
      const existing = this.keypairs.find((k) => k.id === where.id);
      if (!existing) throw new Error('keypair row not found');
      // Only the keys present in `data` are written (mirrors a Prisma partial update); @updatedAt bumps.
      Object.assign(existing, data, { updatedAt: new Date() });
      return existing;
    },
  };

  // -- secretAuditLog -----------------------------------------------------------
  readonly secretAuditLog = {
    create: ({ data }: { data: AuditRow }) => {
      this.audit.push(data);
      return data;
    },
  };

  // -- $transaction -------------------------------------------------------------
  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> =>
    fn(this);
}

function build(): { svc: SecretManagerService; db: FakePrisma } {
  const db = new FakePrisma();
  const svc = new SecretManagerService(db as unknown as PrismaService);
  return { svc, db };
}

/** Create a vault owned by `owner` and return its id. */
async function makeVault(
  svc: SecretManagerService,
  owner: Principal,
  name = 'Vault',
): Promise<string> {
  const v = await svc.createVault(owner, { name, membership: WRAP });
  return v.id;
}

describe('SecretManagerService', () => {
  // ── SA-not-a-subject (defense in depth at the service edge) ───────────────────
  describe('SA-not-a-subject', () => {
    it('rejects a service-account principal on every service entry point (403)', async () => {
      const { svc } = build();
      const sa = serviceAccount();
      await expect(svc.listVaults(sa)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(svc.getMyKeypair(sa)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        svc.changePassword(sa, {
          privateKeyEncByPassphrase: 'bmV3UGFzcw==',
          passphraseSalt: 'bmV3U2FsdA==',
          passphraseIv: 'bmV3SXY=',
          kdfParams: KEYPAIR.kdfParams,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.createVault(sa, { name: 'X', membership: WRAP }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.searchHandles(sa, '')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── INV-10: no endpoint returns plaintext (structural) ────────────────────────
  describe('INV-10 — no plaintext / key material is ever returned', () => {
    it('item reads return only ciphertext/iv/authTag, never a plaintext "value" field', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const item = await svc.createItem(alice, vaultId, {
        handle: 'prod-db',
        label: 'Prod DB',
        ...ENVELOPE,
      });
      // The shape carries ciphertext, not a value; assert there is no decrypted field anywhere.
      const keys = Object.keys(item);
      expect(keys).not.toContain('value');
      expect(keys).not.toContain('plaintext');
      expect(item.ciphertext).toBe(ENVELOPE.ciphertext);
      const list = await svc.listItems(alice, vaultId);
      expect(list[0]).not.toHaveProperty('value');
    });

    it('membership/me returns the wrapped DEK, never an unwrapped DEK', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const mine = await svc.getMyMembership(alice, vaultId);
      expect(mine.wrappedDek).toBe(WRAP.wrappedDek);
      expect(mine).not.toHaveProperty('dek');
      expect(mine).not.toHaveProperty('unwrappedDek');
    });

    it('a user public-key lookup returns ONLY the public key, never a wrapped private key', async () => {
      const { svc } = build();
      const alice = human('alice');
      await svc.createMyKeypair(alice, KEYPAIR);
      const pub = await svc.getUserPublicKey('alice');
      expect(pub).toEqual({ userId: 'alice', publicKey: KEYPAIR.publicKey });
      expect(pub).not.toHaveProperty('privateKeyEncByPassphrase');
      expect(pub).not.toHaveProperty('privateKeyEncByRecovery');
    });
  });

  // ── No-grant-what-you-can't-read (the §4 authorization fence) ──────────────────
  describe('no-grant-what-you-cannot-read', () => {
    it('a non-member with secret:manage CANNOT grant (403) even as ADMIN', async () => {
      const { svc } = build();
      const alice = human('alice'); // creator → member
      const vaultId = await makeVault(svc, alice);
      const adminOutsider = human('boss', 'ADMIN'); // ADMIN but NOT a member
      await expect(
        svc.grantMembership(adminOutsider, vaultId, {
          userId: 'carol',
          ...WRAP,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a live member CAN grant a new member, and it is idempotency-guarded (409 on re-grant)', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const m = await svc.grantMembership(alice, vaultId, {
        userId: 'carol',
        ...WRAP,
      });
      expect(m.userId).toBe('carol');
      expect(
        db.memberships.some(
          (x) => x.vaultId === vaultId && x.userId === 'carol',
        ),
      ).toBe(true);
      await expect(
        svc.grantMembership(alice, vaultId, { userId: 'carol', ...WRAP }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── ADMIN sees metadata, not plaintext (INV-8 vs INV-10) ──────────────────────
  describe('ADMIN sees metadata, never plaintext', () => {
    it('an ADMIN non-member sees ALL vaults (list) and the member list (detail), but NOT items or membership/me', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice, 'Alice Vault');
      await svc.createItem(alice, vaultId, {
        handle: 'h1',
        label: 'L1',
        ...ENVELOPE,
      });

      const admin = human('boss', 'ADMIN'); // not a member of Alice's vault
      // metadata: visible
      const list = await svc.listVaults(admin);
      expect(list.map((v) => v.id)).toContain(vaultId);
      const detail = await svc.getVault(admin, vaultId);
      expect(detail.members.map((m) => m.userId)).toContain('alice');
      const members = await svc.listMembers(admin, vaultId);
      expect(members.map((m) => m.userId)).toContain('alice');
      // plaintext-adjacent (items / wrapped DEK): forbidden without membership
      await expect(svc.listItems(admin, vaultId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(svc.getMyMembership(admin, vaultId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a non-ADMIN non-member sees NEITHER the vault in their list NOR its detail (403)', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const eve = human('eve'); // not a member, not admin
      expect(await svc.listVaults(eve)).toEqual([]);
      await expect(svc.getVault(eve, vaultId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(svc.listMembers(eve, vaultId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ── Membership-gated reads ────────────────────────────────────────────────────
  describe('membership-gated reads', () => {
    it('a non-member (secret:read) is 403 on items / membership-me / by-handle', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      await svc.createItem(alice, vaultId, {
        handle: 'chip-handle',
        label: 'L',
        ...ENVELOPE,
      });
      const eve = human('eve');
      await expect(svc.listItems(eve, vaultId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(svc.getMyMembership(eve, vaultId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        svc.resolveByHandle(eve, 'chip-handle'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a member CAN resolve a chip handle to the envelope + their wrapped DEK', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      await svc.createItem(alice, vaultId, {
        handle: 'chip-handle',
        label: 'L',
        ...ENVELOPE,
      });
      const resolved = await svc.resolveByHandle(alice, 'chip-handle');
      expect(resolved.item.handle).toBe('chip-handle');
      expect(resolved.item.ciphertext).toBe(ENVELOPE.ciphertext);
      expect(resolved.membership.wrappedDek).toBe(WRAP.wrappedDek);
    });

    it("handle autocomplete only offers handles from the caller's own vaults (never values)", async () => {
      const { svc } = build();
      const alice = human('alice');
      const bob = human('bob');
      const aliceVault = await makeVault(svc, alice, 'Alice');
      const bobVault = await makeVault(svc, bob, 'Bob');
      await svc.createItem(alice, aliceVault, {
        handle: 'alice-secret',
        label: 'A',
        ...ENVELOPE,
      });
      await svc.createItem(bob, bobVault, {
        handle: 'bob-secret',
        label: 'B',
        ...ENVELOPE,
      });
      const forAlice = await svc.searchHandles(alice, 'secret');
      expect(forAlice.map((s) => s.handle)).toEqual(['alice-secret']);
      expect(forAlice[0]).not.toHaveProperty('value');
      expect(forAlice[0]).not.toHaveProperty('ciphertext');
    });
  });

  // ── Soft-delete reuse ─────────────────────────────────────────────────────────
  describe('soft-delete reuse', () => {
    it('deleting a vault frees its name and soft-deletes its items + drops its memberships', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice, 'Reused');
      await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });
      await svc.grantMembership(alice, vaultId, { userId: 'carol', ...WRAP });

      await svc.deleteVault(alice, vaultId);
      // memberships hard-dropped
      expect(db.memberships.filter((m) => m.vaultId === vaultId)).toHaveLength(
        0,
      );
      // items soft-deleted
      expect(
        db.items.filter(
          (it) => it.vaultId === vaultId && it.deletedAt === null,
        ),
      ).toHaveLength(0);
      // the name is free again
      const reused = await svc.createVault(alice, {
        name: 'Reused',
        membership: WRAP,
      });
      expect(reused.name).toBe('Reused');
    });

    it('deleting an item frees its handle for reuse', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const item = await svc.createItem(alice, vaultId, {
        handle: 'dup',
        label: 'L',
        ...ENVELOPE,
      });
      await svc.deleteItem(alice, vaultId, item.id);
      const again = await svc.createItem(alice, vaultId, {
        handle: 'dup',
        label: 'L2',
        ...ENVELOPE,
      });
      expect(again.handle).toBe('dup');
    });

    it('a live name/handle collision is a 409', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice, 'Dupe');
      await expect(
        svc.createVault(alice, { name: 'Dupe', membership: WRAP }),
      ).rejects.toBeInstanceOf(ConflictException);
      await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });
      await expect(
        svc.createItem(alice, vaultId, {
          handle: 'h',
          label: 'L2',
          ...ENVELOPE,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── deleteVault↔createItem/updateItem TOCTOU (#425) ───────────────────────────
  describe('deleteVault TOCTOU — in-transaction liveness re-read', () => {
    /**
     * Simulate the race window: the out-of-tx pre-checks pass, then a concurrent deleteVault commits
     * (vault soft-deleted, memberships dropped) before our insert/update runs. We model "commits inside
     * the race window" by mocking `tx` so the in-transaction vault re-read returns no live vault — the
     * #425 fence must then abort with the original not-found error and write NOTHING (no orphan item).
     */
    function raceDeleteVault(db: FakePrisma, vaultId: string): void {
      const realTransaction = db.$transaction.bind(db);
      db.$transaction = (async <T>(fn: (tx: FakePrisma) => Promise<T>) => {
        // Concurrent deleteVault lands in the window: soft-delete the vault + drop its memberships, so the
        // in-tx re-read (assertLiveVaultMembershipTx) sees the vault as absent — exactly the orphan race.
        const vault = db.vaults.find((v) => v.id === vaultId);
        if (vault) vault.deletedAt = new Date();
        db.memberships = db.memberships.filter((m) => m.vaultId !== vaultId);
        return realTransaction(fn);
      }) as FakePrisma['$transaction'];
    }

    it('createItem aborts (404) and creates NO item when the vault dies inside the transaction', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const itemsBefore = db.items.length;

      raceDeleteVault(db, vaultId);

      await expect(
        svc.createItem(alice, vaultId, {
          handle: 'orphan',
          label: 'Would-be orphan',
          ...ENVELOPE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // No live item left under the soft-deleted vault, and its handle is NOT occupied.
      expect(db.items.length).toBe(itemsBefore);
      expect(db.items.some((it) => it.handle === 'orphan')).toBe(false);
    });

    it('updateItem aborts (404) and does NOT resurrect an item when the vault dies inside the transaction', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const item = await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });

      raceDeleteVault(db, vaultId);

      await expect(
        svc.updateItem(alice, vaultId, item.id, { label: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The label edit was NOT applied (the transaction aborted before the update).
      const row = db.items.find((it) => it.id === item.id);
      expect(row?.label).toBe('L');
    });
  });

  // ── Keypair 1:1 + self-only ─────────────────────────────────────────────────
  describe('keypair', () => {
    it('bootstraps once (409 on a second create) and resets in place', async () => {
      const { svc } = build();
      const alice = human('alice');
      await svc.createMyKeypair(alice, KEYPAIR);
      await expect(svc.createMyKeypair(alice, KEYPAIR)).rejects.toBeInstanceOf(
        ConflictException,
      );
      const reset = await svc.resetMyKeypair(alice, {
        ...KEYPAIR,
        publicKey: 'bmV3UHViS2V5',
      });
      expect(reset.publicKey).toBe('bmV3UHViS2V5');
      const mine = await svc.getMyKeypair(alice);
      expect(mine.publicKey).toBe('bmV3UHViS2V5');
    });

    it('getMyKeypair 404s when none exists', async () => {
      const { svc } = build();
      await expect(svc.getMyKeypair(human('alice'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── Change / reset password (ADR-0066): re-wrap ONLY the password wrap (Copy A) ──
  describe('change password', () => {
    // A NEW password wrap (Copy A) — distinct base64 from the original KEYPAIR.* fixtures. Note: the
    // service cannot tell whether the client unlocked with the current password (CHANGE) or the recovery
    // key (RESET); it only ever receives this new Copy-A blob, so one path covers both operations.
    const NEW_PASSWORD = {
      privateKeyEncByPassphrase: 'bmV3UHJpdkVuY1Bhc3M=',
      passphraseSalt: 'bmV3UGFzc1NhbHQ=',
      passphraseIv: 'bmV3UGFzc0l2',
      kdfParams: {
        alg: 'argon2id' as const,
        memorySize: 131072,
        iterations: 4,
        parallelism: 2,
        saltLength: 16,
        hashLength: 32,
        v: 1,
      },
    };

    it('404s when the caller has no keypair (NOT a bootstrap path)', async () => {
      const { svc } = build();
      await expect(
        svc.changePassword(human('alice'), NEW_PASSWORD),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates ONLY the 4 Copy-A columns; public key / recovery wrap unchanged', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      await svc.createMyKeypair(alice, KEYPAIR);
      const before = db.keypairs.find((k) => k.userId === 'alice')!;
      const beforeId = before.id;
      const beforeCreatedAt = before.createdAt;

      const out = await svc.changePassword(alice, NEW_PASSWORD);

      // The 4 Copy-A columns are the NEW blobs.
      expect(out.privateKeyEncByPassphrase).toBe(
        NEW_PASSWORD.privateKeyEncByPassphrase,
      );
      expect(out.passphraseSalt).toBe(NEW_PASSWORD.passphraseSalt);
      expect(out.passphraseIv).toBe(NEW_PASSWORD.passphraseIv);
      expect(out.kdfParams).toEqual(NEW_PASSWORD.kdfParams);

      // EVERYTHING else (public key + the WHOLE recovery wrap, Copy B) is byte-for-byte the original — no
      // keypair rotation, no recovery-wrap touch (so Copy B keeps unlocking; no DEK re-wrap, no churn).
      expect(out.publicKey).toBe(KEYPAIR.publicKey);
      expect(out.privateKeyEncByRecovery).toBe(KEYPAIR.privateKeyEncByRecovery);
      expect(out.recoverySalt).toBe(KEYPAIR.recoverySalt);
      expect(out.recoveryIv).toBe(KEYPAIR.recoveryIv);

      // Same row replaced in place (id stable, createdAt preserved) — never a second keypair minted.
      expect(out.id).toBe(beforeId);
      expect(db.keypairs).toHaveLength(1);
      const after = db.keypairs.find((k) => k.userId === 'alice')!;
      expect(after.createdAt).toEqual(beforeCreatedAt);
      // Re-fetch via the service to confirm the persisted state matches the returned wire.
      const refetched = await svc.getMyKeypair(alice);
      expect(refetched.privateKeyEncByPassphrase).toBe(
        NEW_PASSWORD.privateKeyEncByPassphrase,
      );
      expect(refetched.privateKeyEncByRecovery).toBe(
        KEYPAIR.privateKeyEncByRecovery,
      );
      expect(refetched.publicKey).toBe(KEYPAIR.publicKey);
    });

    it('writes exactly one PASSWORD_CHANGED audit row (metadata only, self-targeted)', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      await svc.createMyKeypair(alice, KEYPAIR); // KEYPAIR_CREATED
      db.audit.length = 0; // isolate the change-password audit row
      await svc.changePassword(alice, NEW_PASSWORD);
      expect(db.audit).toHaveLength(1);
      const row = db.audit[0];
      expect(row.action).toBe('PASSWORD_CHANGED');
      expect(row.actorId).toBe('alice');
      expect(row.targetUserId).toBe('alice'); // self-only
      // metadata only — no blob/value field leaked into the audit row
      expect(Object.keys(row).sort()).toEqual(
        ['action', 'actorId', 'itemId', 'targetUserId', 'vaultId'].sort(),
      );
      expect(JSON.stringify(row)).not.toContain(
        NEW_PASSWORD.privateKeyEncByPassphrase,
      );
    });

    it('is self-only: the target is derived from the principal, not a parameter', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const bob = human('bob');
      await svc.createMyKeypair(alice, KEYPAIR);
      await svc.createMyKeypair(bob, KEYPAIR);

      // Bob changing only touches Bob's row; Alice's password wrap stays the original.
      await svc.changePassword(bob, NEW_PASSWORD);
      const aliceRow = db.keypairs.find((k) => k.userId === 'alice')!;
      const bobRow = db.keypairs.find((k) => k.userId === 'bob')!;
      expect(aliceRow.privateKeyEncByPassphrase).toBe(
        KEYPAIR.privateKeyEncByPassphrase,
      );
      expect(bobRow.privateKeyEncByPassphrase).toBe(
        NEW_PASSWORD.privateKeyEncByPassphrase,
      );
    });

    it('rejects a service-account principal (human-only, 403)', async () => {
      const { svc } = build();
      await expect(
        svc.changePassword(serviceAccount(), NEW_PASSWORD),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── Item envelope all-or-none ─────────────────────────────────────────────────
  describe('item update — envelope all-or-none', () => {
    it('rejects a partial envelope (400) and accepts a label-only edit', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const item = await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });
      await expect(
        svc.updateItem(alice, vaultId, item.id, { ciphertext: 'bmV3' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const labelOnly = await svc.updateItem(alice, vaultId, item.id, {
        label: 'New Label',
      });
      expect(labelOnly.label).toBe('New Label');
      const reEnc = await svc.updateItem(alice, vaultId, item.id, {
        ciphertext: 'bmV3Q2lwaGVy',
        iv: 'bmV3SVY=',
        authTag: 'bmV3VGFn',
        keyVersion: 1,
      });
      expect(reEnc.ciphertext).toBe('bmV3Q2lwaGVy');
    });

    it('an empty PATCH is a 400', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const item = await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });
      await expect(
        svc.updateItem(alice, vaultId, item.id, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── IDOR: item must belong to the path vault ──────────────────────────────────
  describe('IDOR scoping', () => {
    it('an item from another vault is 404 under the wrong vaultId', async () => {
      const { svc } = build();
      const alice = human('alice');
      const v1 = await makeVault(svc, alice, 'V1');
      const v2 = await makeVault(svc, alice, 'V2');
      const item = await svc.createItem(alice, v1, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      });
      await expect(
        svc.updateItem(alice, v2, item.id, { label: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Audit: exactly one metadata-only row per mutation ─────────────────────────
  describe('audit (metadata-only)', () => {
    it('each mutation writes exactly one SecretAuditLog row with the right action + ids and NO blob', async () => {
      const { svc, db } = build();
      const alice = human('alice');

      await svc.createMyKeypair(alice, KEYPAIR); // KEYPAIR_CREATED
      const vaultId = await makeVault(svc, alice); // VAULT_CREATED + MEMBERSHIP_GRANTED (creator)
      const item = await svc.createItem(alice, vaultId, {
        handle: 'h',
        label: 'L',
        ...ENVELOPE,
      }); // ITEM_CREATED
      await svc.updateItem(alice, vaultId, item.id, { label: 'L2' }); // ITEM_UPDATED
      await svc.grantMembership(alice, vaultId, { userId: 'carol', ...WRAP }); // MEMBERSHIP_GRANTED
      await svc.revokeMembership(alice, vaultId, 'carol'); // MEMBERSHIP_REVOKED
      await svc.deleteItem(alice, vaultId, item.id); // ITEM_DELETED
      await svc.deleteVault(alice, vaultId); // VAULT_DELETED
      await svc.resetMyKeypair(alice, KEYPAIR); // KEYPAIR_RESET
      await svc.changePassword(alice, {
        privateKeyEncByPassphrase: 'bmV3UGFzczI=',
        passphraseSalt: 'bmV3U2FsdDI=',
        passphraseIv: 'bmV3SXYy',
        kdfParams: KEYPAIR.kdfParams,
      }); // PASSWORD_CHANGED

      const actions = db.audit.map((a) => a.action);
      expect(actions).toEqual([
        'KEYPAIR_CREATED',
        'VAULT_CREATED',
        'MEMBERSHIP_GRANTED',
        'ITEM_CREATED',
        'ITEM_UPDATED',
        'MEMBERSHIP_GRANTED',
        'MEMBERSHIP_REVOKED',
        'ITEM_DELETED',
        'VAULT_DELETED',
        'KEYPAIR_RESET',
        'PASSWORD_CHANGED',
      ]);
      // metadata only — no blob/value field on any audit row
      for (const row of db.audit) {
        expect(Object.keys(row).sort()).toEqual(
          ['action', 'actorId', 'itemId', 'targetUserId', 'vaultId'].sort(),
        );
        expect(row.actorId).toBe('alice');
      }
      // a couple of targeted assertions
      const grantRow = db.audit.find(
        (a) => a.action === 'MEMBERSHIP_GRANTED' && a.targetUserId === 'carol',
      );
      expect(grantRow?.vaultId).toBe(vaultId);
      const revokeRow = db.audit.find((a) => a.action === 'MEMBERSHIP_REVOKED');
      expect(revokeRow?.targetUserId).toBe('carol');
    });
  });

  // ── export audit (#612) — metadata-only, NO plaintext touches the server ──────────
  describe('export audit (ITEMS_EXPORTED, #612)', () => {
    it('a member records an export → exactly one ITEMS_EXPORTED audit row (metadata only, no value)', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      await svc.createItem(alice, vaultId, {
        handle: 'prod-db',
        label: 'Prod DB',
        ...ENVELOPE,
      });
      db.audit.length = 0; // isolate the export audit row

      const ack = await svc.recordExport(alice, vaultId, { itemCount: 1 });
      expect(ack).toEqual({ ok: true, itemCount: 1 });

      expect(db.audit).toHaveLength(1);
      const row = db.audit[0];
      expect(row.action).toBe('ITEMS_EXPORTED');
      expect(row.actorId).toBe('alice');
      expect(row.vaultId).toBe(vaultId);
      // METADATA ONLY: the row carries no value/key/blob — only the standard audit columns.
      expect(Object.keys(row).sort()).toEqual(
        ['action', 'actorId', 'itemId', 'targetUserId', 'vaultId'].sort(),
      );
    });

    it('takes NO secret material: the service signature accepts only an optional non-secret itemCount', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      // No body at all is valid (the count is optional); the audit row is still written, ack count null.
      const ack = await svc.recordExport(alice, vaultId);
      expect(ack).toEqual({ ok: true, itemCount: null });
      // There is no parameter through which a plaintext value/key could reach the server: the only
      // accepted field is `itemCount`. The strict zod DTO (ExportSecretsAuditSchema) rejects any other
      // key at the controller edge — proven in the shared schema test.
    });

    it('a non-member (even with secret:read) cannot record an export (403) — exporting is member-only', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      const eve = human('eve');
      await expect(svc.recordExport(eve, vaultId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('a service-account principal is rejected (403) — human-only', async () => {
      const { svc } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      await expect(
        svc.recordExport(serviceAccount(), vaultId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('exporting a missing/soft-deleted vault is a 404', async () => {
      const { svc } = build();
      const alice = human('alice');
      await expect(
        svc.recordExport(alice, 'cvault00000000000000nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── revoke / rename basics ────────────────────────────────────────────────────
  describe('membership revoke + vault rename', () => {
    it('revoking a non-member is a 404; revoking a member hard-drops the row', async () => {
      const { svc, db } = build();
      const alice = human('alice');
      const vaultId = await makeVault(svc, alice);
      await expect(
        svc.revokeMembership(alice, vaultId, 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await svc.grantMembership(alice, vaultId, { userId: 'carol', ...WRAP });
      await svc.revokeMembership(alice, vaultId, 'carol');
      expect(db.memberships.some((m) => m.userId === 'carol')).toBe(false);
    });

    it('rename rejects a colliding name (409)', async () => {
      const { svc } = build();
      const alice = human('alice');
      await makeVault(svc, alice, 'Taken');
      const other = await makeVault(svc, alice, 'Free');
      await expect(
        svc.renameVault(alice, other, { name: 'Taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
      const renamed = await svc.renameVault(alice, other, { name: 'Renamed' });
      expect(renamed.name).toBe('Renamed');
    });
  });
});
