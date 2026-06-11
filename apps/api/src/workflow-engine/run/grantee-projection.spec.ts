import { projectGrantee, type GranteeSource } from './grantee-projection';

/** A baseline grantee source (no manager, no directory fields) the cases override. */
function source(overrides: Partial<GranteeSource> = {}): GranteeSource {
  return {
    id: 'usr_1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    legajo: null,
    username: null,
    managerName: null,
    manager: null,
    ...overrides,
  };
}

describe('projectGrantee — ADR-0058 mapper identity fields', () => {
  it('surfaces legajo / username verbatim (null when not recorded)', () => {
    expect(projectGrantee(source()).legajo).toBeNull();
    expect(projectGrantee(source()).username).toBeNull();
    const filled = projectGrantee(
      source({ legajo: 'A-1234', username: 'ada' }),
    );
    expect(filled.legajo).toBe('A-1234');
    expect(filled.username).toBe('ada');
  });

  it('keeps the base identity fields (id/email/firstName/lastName)', () => {
    const g = projectGrantee(source());
    expect(g).toMatchObject({
      id: 'usr_1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  describe('manager descriptor (redaction-safe, INV-6)', () => {
    it('a LIVE linked manager → name + email, not offboarded', () => {
      const g = projectGrantee(
        source({
          manager: {
            firstName: 'Grace',
            lastName: 'Hopper',
            email: 'grace@example.com',
            deletedAt: null,
          },
        }),
      );
      expect(g.manager).toEqual({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        isOffboarded: false,
      });
    });

    it('the free-text fallback (managerName) → name only, no email', () => {
      const g = projectGrantee(source({ managerName: 'Ana Pérez (HR)' }));
      expect(g.manager).toEqual({
        name: 'Ana Pérez (HR)',
        email: null,
        isOffboarded: false,
      });
    });

    it('an OFFBOARDED (soft-deleted) linked manager → blanked name/email, isOffboarded flagged', () => {
      const g = projectGrantee(
        source({
          manager: {
            firstName: 'Grace',
            lastName: 'Hopper',
            email: 'grace@example.com',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        }),
      );
      // INV-6 / ADR-0058 §3: never leak an offboarded person's name/email — empty, but flagged.
      expect(g.manager).toEqual({
        name: null,
        email: null,
        isOffboarded: true,
      });
    });

    it('no manager recorded → all-empty descriptor (never a dangle)', () => {
      expect(projectGrantee(source()).manager).toEqual({
        name: null,
        email: null,
        isOffboarded: false,
      });
    });

    it('a linked manager wins over the free-text fallback (they are mutually exclusive)', () => {
      const g = projectGrantee(
        source({
          managerName: 'ignored',
          manager: {
            firstName: 'Grace',
            lastName: 'Hopper',
            email: 'grace@example.com',
            deletedAt: null,
          },
        }),
      );
      expect(g.manager.name).toBe('Grace Hopper');
    });
  });
});
