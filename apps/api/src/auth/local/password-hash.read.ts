import type {
  AppPrismaClient,
  AppTransactionClient,
} from '../../prisma/prisma-omit';

/**
 * The dedicated credential read (ADR-0105, SEC-085 follow-up). `passwordHash` is globally omitted, so
 * neither the authenticated principal nor any default query carries it; the paths that must check a
 * password (step-up, the OAuth consent's local-password check) read it here, by id, and use it once.
 *
 * Live rows only (the soft-delete filter applies). Returns `null` for an unknown user and for a user
 * with no local password (OIDC / directory-only), which every caller treats as "fail closed".
 */
export async function readPasswordHash(
  prisma: Pick<AppPrismaClient | AppTransactionClient, 'user'>,
  userId: string,
): Promise<string | null> {
  const row = await prisma.user.findFirst({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return row?.passwordHash ?? null;
}
