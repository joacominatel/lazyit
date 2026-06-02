import { ForbiddenException } from '@nestjs/common';
import {
  assertCanListDeleted,
  deletedWhere,
  includeSoftDeletedFor,
} from './deleted-filter';
import type { User } from '../../generated/prisma/client';

const asUser = (role: string): User => ({ id: 'u1', role }) as unknown as User;

/**
 * The ADR-0030 addendum / ADR-0041 soft-delete list slice helpers: the controller-side ADMIN gate
 * for the `only` slice, the service-side `deletedAt` where fragment, and the escape-hatch flag.
 */
describe('deleted-filter', () => {
  describe('assertCanListDeleted (controller ADMIN gate)', () => {
    it('is a no-op for the active slice regardless of role (and anonymous)', () => {
      expect(() =>
        assertCanListDeleted('active', asUser('ADMIN')),
      ).not.toThrow();
      expect(() =>
        assertCanListDeleted('active', asUser('MEMBER')),
      ).not.toThrow();
      expect(() =>
        assertCanListDeleted('active', asUser('VIEWER')),
      ).not.toThrow();
      expect(() => assertCanListDeleted('active', undefined)).not.toThrow();
    });

    it('allows an ADMIN to list the only (archived) slice', () => {
      expect(() => assertCanListDeleted('only', asUser('ADMIN'))).not.toThrow();
    });

    it('403s a non-admin asking for the only slice', () => {
      expect(() => assertCanListDeleted('only', asUser('MEMBER'))).toThrow(
        ForbiddenException,
      );
      expect(() => assertCanListDeleted('only', asUser('VIEWER'))).toThrow(
        ForbiddenException,
      );
    });

    it('403s an anonymous caller asking for the only slice', () => {
      expect(() => assertCanListDeleted('only', undefined)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('deletedWhere (service where fragment)', () => {
    it('scopes the active slice to live rows (deletedAt: null)', () => {
      expect(deletedWhere('active')).toEqual({ deletedAt: null });
    });

    it('scopes the only slice to soft-deleted rows (deletedAt: { not: null })', () => {
      expect(deletedWhere('only')).toEqual({ deletedAt: { not: null } });
    });
  });

  describe('includeSoftDeletedFor (escape-hatch flag)', () => {
    it('is true only for the only slice', () => {
      expect(includeSoftDeletedFor('only')).toBe(true);
      expect(includeSoftDeletedFor('active')).toBe(false);
    });
  });
});
