import type { WorkflowMappingContext } from '../handlers/step-handler';

/**
 * The grantee `User` → mapping-context `grantee` projection (ADR-0058 §3). Framework-pure (no Prisma /
 * Nest import) so it can be unit-tested in isolation and SHARED by both the live run
 * ({@link import('./run-context').RunContextBuilder}) and the dry-run preview — both resolve the SAME
 * `grantee.{legajo,username,manager}` tokens. The manager descriptor is redaction-safe (INV-6): only a
 * display name + (live-manager) email + an `isOffboarded` flag ever leave this projection.
 */

/**
 * The minimal grantee `User` shape this projection reads — the columns + the nested manager relation
 * loaded by both the live run and the dry-run preview. The nested `manager` is loaded WITHOUT the
 * soft-delete filter (a nested relation isn't scoped by the read filter, ADR-0032), so a soft-deleted
 * (offboarded) manager is still present and we flag it rather than dangle.
 */
export interface GranteeSource {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  legajo: string | null;
  username: string | null;
  managerName: string | null;
  manager: {
    firstName: string;
    lastName: string;
    email: string;
    deletedAt: Date | null;
  } | null;
}

/**
 * Project a loaded grantee `User` into the mapping context's `grantee` shape (ADR-0058 §3). The manager
 * descriptor is redaction-safe (INV-6): a LIVE linked manager yields `name`/`email`; the free-text
 * fallback yields `name` only; no manager OR a soft-deleted (offboarded) linked manager yields empty
 * leaves (with `isOffboarded` flagging the soft-deleted case so the builder warns the token renders
 * blank).
 */
export function projectGrantee(
  user: GranteeSource,
): WorkflowMappingContext['grantee'] {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    legajo: user.legajo,
    username: user.username,
    manager: projectManager(user),
  };
}

/** Build the redaction-safe manager descriptor (ADR-0058 §3 / INV-6). See {@link projectGrantee}. */
function projectManager(
  user: Pick<GranteeSource, 'managerName' | 'manager'>,
): WorkflowMappingContext['grantee']['manager'] {
  // A linked lazyit user wins over the free-text fallback (they are mutually exclusive by DB CHECK).
  if (user.manager) {
    const offboarded = user.manager.deletedAt != null;
    return {
      // A soft-deleted manager is BLANKED — never leak an offboarded person's name/email (ADR-0058 §3).
      name: offboarded
        ? null
        : `${user.manager.firstName} ${user.manager.lastName}`,
      email: offboarded ? null : user.manager.email,
      isOffboarded: offboarded,
    };
  }
  if (user.managerName != null) {
    return { name: user.managerName, email: null, isOffboarded: false };
  }
  // No manager recorded (or a managerId whose row is genuinely gone) → empty, never a dangle.
  return { name: null, email: null, isOffboarded: false };
}
