import { Test } from '@nestjs/testing';
import { FolderAccessService, folderVisible } from './folder-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/principal';
import type { Role, User } from '../../generated/prisma/client';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type FolderRow = {
  id: string;
  parentId: string | null;
  accessRules: unknown;
};

/**
 * FolderAccessService — the ADR-0060 §4 read-path evaluator. These tests pin the security invariants
 * the merge gate requires (ADMIN-sees-all §5, SA fail-closed §8, inherit-narrow-never-widen §1, and
 * dynamic-by-construction §3: a revoked grant / released assignment drops access on the next read).
 */
describe('FolderAccessService (ADR-0060 §4)', () => {
  let service: FolderAccessService;
  let articleCategory: { findMany: jest.Mock };
  let accessGrant: { findMany: jest.Mock };
  let assetAssignment: { findMany: jest.Mock };

  const wireFolders = (rows: FolderRow[]) =>
    articleCategory.findMany.mockResolvedValue(rows);
  const wireGrants = (applicationIds: string[]) =>
    accessGrant.findMany.mockResolvedValue(
      applicationIds.map((applicationId) => ({ applicationId })),
    );
  const wireAssignments = (assetIds: string[]) =>
    assetAssignment.findMany.mockResolvedValue(
      assetIds.map((assetId) => ({ assetId })),
    );

  const human = (id: string, role: Role): Principal => ({
    kind: 'human',
    user: { id, role } as User,
  });
  const sa = (): Principal => ({
    kind: 'service',
    serviceAccount: { id: 'sa1' } as never,
    permissions: new Set(),
  });

  beforeEach(async () => {
    articleCategory = { findMany: jest.fn() };
    accessGrant = { findMany: jest.fn().mockResolvedValue([]) };
    assetAssignment = { findMany: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FolderAccessService,
        {
          provide: PrismaService,
          useValue: { articleCategory, accessGrant, assetAssignment },
        },
      ],
    }).compile();

    service = moduleRef.get(FolderAccessService);
  });

  describe('§5 ADMIN god-mode — sees every folder', () => {
    it('returns ALL for an ADMIN without scanning folders', async () => {
      const visible = await service.visibleFolderIds(human('admin', 'ADMIN'));
      expect(visible).toBe('ALL');
      // ADMIN short-circuits: no folder/grant/assignment query is issued.
      expect(articleCategory.findMany).not.toHaveBeenCalled();
      expect(folderVisible(visible, 'any-restricted-folder')).toBe(true);
    });
  });

  describe('§2 PUBLIC fast-path — no restricted folder', () => {
    it('returns every folder id and never queries the live joins', async () => {
      wireFolders([
        { id: 'f1', parentId: null, accessRules: null },
        { id: 'f2', parentId: 'f1', accessRules: [] },
      ]);
      const visible = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(visible, 'f1')).toBe(true);
      expect(folderVisible(visible, 'f2')).toBe(true);
      expect(accessGrant.findMany).not.toHaveBeenCalled();
      expect(assetAssignment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('§8 service accounts fail closed on restricted folders', () => {
    it('an SA sees PUBLIC folders but never a restricted one', async () => {
      wireFolders([
        { id: 'pub', parentId: null, accessRules: null },
        { id: 'sec', parentId: null, accessRules: [{ kind: 'role', role: 'MEMBER' }] },
      ]);
      const visible = await service.visibleFolderIds(sa());
      expect(folderVisible(visible, 'pub')).toBe(true);
      expect(folderVisible(visible, 'sec')).toBe(false);
      // An SA never even evaluates the rules — no live-join lookup.
      expect(accessGrant.findMany).not.toHaveBeenCalled();
    });
  });

  describe('§3 OR rules over live joins', () => {
    it('users rule — only the listed users match', async () => {
      wireFolders([
        {
          id: 'sec',
          parentId: null,
          accessRules: [{ kind: 'users', userIds: ['u1'] }],
        },
      ]);
      const yes = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(yes, 'sec')).toBe(true);
      const no = await service.visibleFolderIds(human('u2', 'VIEWER'));
      expect(folderVisible(no, 'sec')).toBe(false);
    });

    it('role rule — only holders of that role match', async () => {
      wireFolders([
        { id: 'sec', parentId: null, accessRules: [{ kind: 'role', role: 'MEMBER' }] },
      ]);
      const member = await service.visibleFolderIds(human('u1', 'MEMBER'));
      expect(folderVisible(member, 'sec')).toBe(true);
      const viewer = await service.visibleFolderIds(human('u2', 'VIEWER'));
      expect(folderVisible(viewer, 'sec')).toBe(false);
    });

    it('appGrant rule — holder of an ACTIVE grant matches (revoked drops it)', async () => {
      wireFolders([
        {
          id: 'sec',
          parentId: null,
          accessRules: [{ kind: 'appGrant', applicationId: 'appFinance' }],
        },
      ]);
      // Active grant present → visible.
      wireGrants(['appFinance']);
      const granted = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(granted, 'sec')).toBe(true);
      expect(accessGrant.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        select: { applicationId: true },
      });

      // Grant revoked (no active row returned) → access disappears on the next read (dynamic).
      wireGrants([]);
      const revoked = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(revoked, 'sec')).toBe(false);
    });

    it('assetAssignment rule — current assignee matches (release drops it)', async () => {
      wireFolders([
        {
          id: 'sec',
          parentId: null,
          accessRules: [{ kind: 'assetAssignment', assetId: 'laptop1' }],
        },
      ]);
      // Currently assigned → visible.
      wireAssignments(['laptop1']);
      const assigned = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(assigned, 'sec')).toBe(true);
      expect(assetAssignment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', releasedAt: null },
        select: { assetId: true },
      });

      // Released (no active assignment) → access disappears on the next read (dynamic).
      wireAssignments([]);
      const released = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(released, 'sec')).toBe(false);
    });
  });

  describe('§1 inherit-and-narrow — a child can never widen past a restricted ancestor', () => {
    it('a PUBLIC child under a restricted parent is HIDDEN from a non-matching caller', async () => {
      // parent restricted to MEMBER; child is PUBLIC (no own rule). A VIEWER fails the parent, so the
      // child is hidden too — the child cannot widen the parent's restriction (no escalation).
      wireFolders([
        { id: 'parent', parentId: null, accessRules: [{ kind: 'role', role: 'MEMBER' }] },
        { id: 'child', parentId: 'parent', accessRules: null },
      ]);
      const viewer = await service.visibleFolderIds(human('u1', 'VIEWER'));
      expect(folderVisible(viewer, 'parent')).toBe(false);
      expect(folderVisible(viewer, 'child')).toBe(false);

      // A MEMBER matches the parent, so BOTH parent and the public child are visible.
      const member = await service.visibleFolderIds(human('u2', 'MEMBER'));
      expect(folderVisible(member, 'parent')).toBe(true);
      expect(folderVisible(member, 'child')).toBe(true);
    });

    it('a child NARROWS further: matching the parent is not enough if the child also restricts', async () => {
      // parent → MEMBER; child → additionally only user u-allowed. A MEMBER who is NOT u-allowed sees
      // the parent but NOT the child (the child narrows; effective = own ∩ ancestors).
      wireFolders([
        { id: 'parent', parentId: null, accessRules: [{ kind: 'role', role: 'MEMBER' }] },
        {
          id: 'child',
          parentId: 'parent',
          accessRules: [{ kind: 'users', userIds: ['u-allowed'] }],
        },
      ]);
      const otherMember = await service.visibleFolderIds(human('u-other', 'MEMBER'));
      expect(folderVisible(otherMember, 'parent')).toBe(true);
      expect(folderVisible(otherMember, 'child')).toBe(false);

      // The allowed user must ALSO clear the ancestor: u-allowed as a VIEWER fails the MEMBER parent,
      // so even though they match the child's OWN rule, the child stays hidden (never widen).
      const allowedButViewer = await service.visibleFolderIds(human('u-allowed', 'VIEWER'));
      expect(folderVisible(allowedButViewer, 'child')).toBe(false);

      // u-allowed as a MEMBER clears both → child visible.
      const allowedMember = await service.visibleFolderIds(human('u-allowed', 'MEMBER'));
      expect(folderVisible(allowedMember, 'child')).toBe(true);
    });
  });

  describe('anonymous / no principal', () => {
    it('an anonymous caller sees only PUBLIC folders (matches no restriction)', async () => {
      wireFolders([
        { id: 'pub', parentId: null, accessRules: null },
        { id: 'sec', parentId: null, accessRules: [{ kind: 'role', role: 'VIEWER' }] },
      ]);
      const visible = await service.visibleFolderIds(undefined);
      expect(folderVisible(visible, 'pub')).toBe(true);
      expect(folderVisible(visible, 'sec')).toBe(false);
    });
  });

  describe('§599 request-scoped folder-tree memo', () => {
    it('loads the folder tree ONCE when a cache is shared across calls in a request', async () => {
      wireFolders([
        { id: 'pub', parentId: null, accessRules: null },
        {
          id: 'sec',
          parentId: null,
          accessRules: [{ kind: 'appGrant', applicationId: 'appFinance' }],
        },
      ]);
      wireGrants(['appFinance']);

      const cache = {};
      // Two resolutions in the SAME request (e.g. findOne + backlinks), sharing one cache.
      const first = await service.visibleFolderIds(human('u1', 'VIEWER'), cache);
      const second = await service.visibleFolderIds(human('u1', 'VIEWER'), cache);

      // The expensive full folder-tree scan runs exactly once for the whole request...
      expect(articleCategory.findMany).toHaveBeenCalledTimes(1);
      // ...but the live-join lookup runs on EVERY call (dynamic-by-construction — zero staleness).
      expect(accessGrant.findMany).toHaveBeenCalledTimes(2);
      // Same resolved visibility both times.
      expect(folderVisible(first, 'sec')).toBe(true);
      expect(folderVisible(second, 'sec')).toBe(true);
    });

    it('a revoked grant drops access on the NEXT call even with the tree cached (live joins stay fresh)', async () => {
      wireFolders([
        {
          id: 'sec',
          parentId: null,
          accessRules: [{ kind: 'appGrant', applicationId: 'appFinance' }],
        },
      ]);
      const cache = {};

      // First call: active grant → visible.
      wireGrants(['appFinance']);
      const granted = await service.visibleFolderIds(human('u1', 'VIEWER'), cache);
      expect(folderVisible(granted, 'sec')).toBe(true);

      // Grant revoked between calls: the cached TREE is reused, but the live join is re-read → hidden.
      wireGrants([]);
      const revoked = await service.visibleFolderIds(human('u1', 'VIEWER'), cache);
      expect(folderVisible(revoked, 'sec')).toBe(false);
      // The tree was still loaded only once across both calls.
      expect(articleCategory.findMany).toHaveBeenCalledTimes(1);
    });

    it('without a cache, each call reloads the folder tree (no cross-call memoization)', async () => {
      wireFolders([{ id: 'pub', parentId: null, accessRules: null }]);

      await service.visibleFolderIds(human('u1', 'VIEWER'));
      await service.visibleFolderIds(human('u1', 'VIEWER'));

      expect(articleCategory.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('malformed stored rules fail closed (not silently PUBLIC)', () => {
    it('an unparseable accessRules value hides the folder from a non-admin', async () => {
      wireFolders([
        { id: 'bad', parentId: null, accessRules: [{ kind: 'bogus' }] },
      ]);
      const visible = await service.visibleFolderIds(human('u1', 'MEMBER'));
      expect(folderVisible(visible, 'bad')).toBe(false);
    });
  });
});
