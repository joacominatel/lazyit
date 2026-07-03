/**
 * Core logic for the admin-recovery flow (ADR-0086 §5, F1d / #994) — the ONLY recovery path when
 * every ADMIN of a local-auth (AUTH_MODE=local) instance is locked out and there is no SMTP-based
 * reset (a gap the ADR explicitly accepts). Pure-ish and framework-agnostic, mirroring the
 * `reindexIndex` precedent (`src/search/reindex.ts`): it depends only on the small
 * {@link ResetAdminPasswordClient} / {@link ResetAdminPasswordCredentials} surfaces (structural
 * subsets of Prisma's `user` delegate and `LocalCredentialService`), so it is unit-testable with a
 * fake client and carries NO Nest/DI dependency of its own. The `apps/api/scripts/reset-admin-
 * password.ts` CLI is a thin wrapper that wires the real `PrismaClient` + `LocalCredentialService`
 * around this function.
 *
 * Deliberately narrow: this refuses anyone who is not a LIVE ADMIN — it is a login-recovery tool
 * for the instance's administrator, not a general "set anyone's password" tool. On success it
 * hashes with the app's exact argon2id params (via the injected credentials.hash, i.e.
 * LocalCredentialService — ARGON2ID_PARAMS, @lazyit/shared) and BUMPS `sessionEpoch`, so the result
 * is byte-for-byte interchangeable with an app-set hash and every existing session for that account
 * is revoked immediately (ADR-0086 §3) — a session token minted before the reset can never survive
 * it.
 */

/** The minimal live-user shape {@link resetAdminPassword} needs from a lookup. */
export interface LiveAdminCandidate {
  id: string;
  email: string;
  role: string;
}

/**
 * The minimal Prisma `user` delegate surface this needs — a structural subset of the real
 * `PrismaClient.user`, so the real client satisfies it and a fake one is trivial to mock. Callers
 * MUST filter `deletedAt: null` themselves (a raw `PrismaClient`, as used by the CLI, has no
 * soft-delete extension — see `set-role.ts`'s precedent) and match on email OR username.
 */
export interface ResetAdminPasswordClient {
  user: {
    findFirst(args: {
      where: {
        deletedAt: null;
        OR: Array<{ email: string } | { username: string }>;
      };
      select: { id: true; email: true; role: true };
    }): Promise<LiveAdminCandidate | null>;
    update(args: {
      where: { id: string };
      data: {
        passwordHash: string;
        passwordUpdatedAt: Date;
        sessionEpoch: { increment: number };
      };
    }): Promise<unknown>;
  };
}

/** The minimal hashing surface — satisfied by `LocalCredentialService`. */
export interface ResetAdminPasswordCredentials {
  hash(password: string): Promise<string>;
}

/** The outcome of a successful reset. */
export interface ResetAdminPasswordResult {
  id: string;
  email: string;
}

/**
 * Reset a named ADMIN's local-auth password. Throws (never returns) on every refusal path: an
 * empty identifier/password, no LIVE user matching `identifier` (email or username, case-
 * insensitive), or a live user found but NOT `role === 'ADMIN'` — this is an admin-login recovery
 * tool only, never a general password-set. On success: hashes `password` via `credentials.hash`
 * (the app's argon2id, so the result verifies exactly like any app-set hash), sets
 * `passwordHash`/`passwordUpdatedAt`, and increments `sessionEpoch` by 1 (revokes every existing
 * session for the account, ADR-0086 §3).
 */
export async function resetAdminPassword(
  prisma: ResetAdminPasswordClient,
  credentials: ResetAdminPasswordCredentials,
  identifier: string,
  password: string,
): Promise<ResetAdminPasswordResult> {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) {
    throw new Error('an email or username is required');
  }
  if (!password) {
    throw new Error('the new password must not be empty');
  }

  // Matches the citext `email` column (case-insensitive) and the lowercased-on-write `username`
  // column (ADR-0041/0058) — same normalize-then-OR lookup as LoginService.
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: normalized }, { username: normalized }],
    },
    select: { id: true, email: true, role: true },
  });
  if (!user) {
    throw new Error(`no LIVE user found for "${identifier}"`);
  }
  if (user.role !== 'ADMIN') {
    throw new Error(
      `"${identifier}" is not an ADMIN (role=${user.role}) — this tool only resets an administrator's login; use the Users section (or set-role) to promote them first`,
    );
  }

  const passwordHash = await credentials.hash(password);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordUpdatedAt: new Date(),
      // Revoke every existing session for this account (ADR-0086 §3) — a stale token minted before
      // the reset compares its `epoch` claim against the row's (now-bumped) `sessionEpoch` and fails.
      sessionEpoch: { increment: 1 },
    },
  });

  return { id: user.id, email: user.email };
}
