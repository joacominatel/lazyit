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

  it('SOFT_DELETABLE_MODELS lists exactly the 12 mutable domain entities', () => {
    expect(SOFT_DELETABLE_MODELS.has('User')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('Asset')).toBe(true);
    // ServiceAccount is soft-deletable (revoke = soft delete; ADR-0048).
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccount')).toBe(true);
    // Consumable + ConsumableCategory carry deletedAt (ADR-0034) — SEC-050.
    expect(SOFT_DELETABLE_MODELS.has('Consumable')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('ConsumableCategory')).toBe(true);
    expect(SOFT_DELETABLE_MODELS.has('AssetAssignment')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('AccessGrant')).toBe(false);
    // ConsumableMovement is an append-only ledger (ADR-0006/0034) — NOT soft-deletable.
    expect(SOFT_DELETABLE_MODELS.has('ConsumableMovement')).toBe(false);
    // ServiceAccountPermission (join) and ServiceAccountAuditLog (append-only) are NOT soft-deletable.
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccountPermission')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.has('ServiceAccountAuditLog')).toBe(false);
    expect(SOFT_DELETABLE_MODELS.size).toBe(12);
  });

  it('auto-scopes Consumable / ConsumableCategory reads to deletedAt: null (SEC-050)', () => {
    expect(
      withSoftDeleteFilter('Consumable', 'findFirst', { where: { id: 'k1' } }),
    ).toEqual({ where: { id: 'k1', deletedAt: null } });
    expect(
      withSoftDeleteFilter('ConsumableCategory', 'findMany', {}),
    ).toEqual({ where: { deletedAt: null } });
  });
});
