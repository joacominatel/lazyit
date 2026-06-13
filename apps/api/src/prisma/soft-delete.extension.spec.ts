import {
  SOFT_DELETABLE_MODELS,
  withSoftDeleteFilter,
} from './soft-delete.extension';

describe('withSoftDeleteFilter (soft-delete query filter — ADR-0032)', () => {
  describe('filtered reads on soft-deletable models', () => {
    it('adds deletedAt: null when there is no where', () => {
      expect(
        withSoftDeleteFilter('User', 'findMany', {
          orderBy: { createdAt: 'desc' },
        }),
      ).toEqual({ orderBy: { createdAt: 'desc' }, where: { deletedAt: null } });
    });

    it('merges deletedAt: null into an existing where', () => {
      expect(
        withSoftDeleteFilter('Article', 'findFirst', { where: { id: 'a1' } }),
      ).toEqual({ where: { id: 'a1', deletedAt: null } });
    });

    it('handles undefined args', () => {
      expect(withSoftDeleteFilter('Location', 'count', undefined)).toEqual({
        where: { deletedAt: null },
      });
    });

    it('applies to count / aggregate / groupBy too', () => {
      for (const op of ['count', 'aggregate', 'groupBy']) {
        expect(withSoftDeleteFilter('Application', op, {})).toEqual({
          where: { deletedAt: null },
        });
      }
    });
  });

  describe('escape hatch', () => {
    it('includeSoftDeleted: true strips the flag and skips the filter', () => {
      expect(
        withSoftDeleteFilter('User', 'findMany', {
          where: { id: 'u1' },
          includeSoftDeleted: true,
        }),
      ).toEqual({ where: { id: 'u1' } });
    });

    it('includeSoftDeleted: false still filters (only true opts out) and is stripped', () => {
      expect(
        withSoftDeleteFilter('User', 'findMany', { includeSoftDeleted: false }),
      ).toEqual({ where: { deletedAt: null } });
    });
  });

  describe('pass-through (no deletedAt injected)', () => {
    it('leaves non-soft-deletable models untouched (AssetAssignment, AccessGrant)', () => {
      expect(
        withSoftDeleteFilter('AssetAssignment', 'findMany', {
          where: { releasedAt: null },
        }),
      ).toEqual({ where: { releasedAt: null } });
      expect(
        withSoftDeleteFilter('AccessGrant', 'findFirst', {
          where: { id: 'g1' },
        }),
      ).toEqual({ where: { id: 'g1' } });
    });

    it('leaves writes (create/update/delete) untouched', () => {
      expect(
        withSoftDeleteFilter('User', 'update', {
          where: { id: 'u1' },
          data: { firstName: 'Ada' },
        }),
      ).toEqual({ where: { id: 'u1' }, data: { firstName: 'Ada' } });
      expect(
        withSoftDeleteFilter('User', 'delete', { where: { id: 'u1' } }),
      ).toEqual({ where: { id: 'u1' } });
    });

    it('does NOT filter findUnique / findUniqueOrThrow', () => {
      expect(
        withSoftDeleteFilter('User', 'findUnique', { where: { id: 'u1' } }),
      ).toEqual({ where: { id: 'u1' } });
      expect(
        withSoftDeleteFilter('User', 'findUniqueOrThrow', {
          where: { id: 'u1' },
        }),
      ).toEqual({ where: { id: 'u1' } });
    });

    it('ignores an undefined model', () => {
      expect(
        withSoftDeleteFilter(undefined, 'findMany', { where: {} }),
      ).toEqual({
        where: {},
      });
    });
  });

  it('SOFT_DELETABLE_MODELS lists exactly the 14 mutable domain entities', () => {
    expect(SOFT_DELETABLE_MODELS.has('User')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('Asset')).toBe(true);
    // ServiceAccount is soft-deletable (revoke = soft delete; ADR-0048).
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccount')).toBe(true);
    // ConsumableCategory is auto-scoped (#321); its service carries no explicit deletedAt guard.
    expect(SOFT_DELETABLE_MODELS.has('ConsumableCategory')).toBe(true);
    // Secret Manager (ADR-0061, #366): the three MUTABLE entities are soft-deletable.
    expect(SOFT_DELETABLE_MODELS.has('SecretVault')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('SecretItem')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('UserKeypair')).toBe(true);
    // Consumable itself stays OUT: its service filters deletedAt explicitly for the archived view.
    expect(SOFT_DELETABLE_MODELS.has('Consumable')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('AssetAssignment')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('AccessGrant')).toBe(false);
    // ServiceAccountPermission (join) and ServiceAccountAuditLog (append-only) are NOT soft-deletable.
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccountPermission')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccountAuditLog')).toBe(false);
    // VaultMembership (v1 hard-drop revoke — a current-state join) and SecretAuditLog (append-only) are
    // DELIBERATELY excluded from the soft-delete set (ADR-0061 §4/§10).
    expect(SOFT_DELETABLE_MODELS.has('VaultMembership')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('SecretAuditLog')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.size).toBe(14);
  });

  it('auto-scopes ConsumableCategory reads to live rows (#321)', () => {
    expect(
      withSoftDeleteFilter('ConsumableCategory', 'findMany', {
        orderBy: [{ name: 'asc' }],
      }),
    ).toEqual({ orderBy: [{ name: 'asc' }], where: { deletedAt: null } });
    expect(
      withSoftDeleteFilter('ConsumableCategory', 'findFirst', {
        where: { id: 'cc1' },
      }),
    ).toEqual({ where: { id: 'cc1', deletedAt: null } });
    // The restore escape hatch still bypasses the filter.
    expect(
      withSoftDeleteFilter('ConsumableCategory', 'findFirst', {
        where: { id: 'cc1' },
        includeSoftDeleted: true,
      }),
    ).toEqual({ where: { id: 'cc1' } });
  });
});
