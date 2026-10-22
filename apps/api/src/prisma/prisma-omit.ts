import type * as runtime from '@prisma/client/runtime/client';
import type {
  Prisma,
  PrismaClient,
  ServiceAccount,
  User,
} from '../../generated/prisma/client';

/**
 * Client-level `omit` for the secret and permission-gated columns (ADR-0105, #1518).
 *
 * Every query made through {@link PrismaService} (and the sandboxed processors' own clients) leaves
 * these columns out of the result unless the query opts back in with `omit: { <col>: false }` or an
 * explicit `select` that names the column. An omitted column also disappears from the TypeScript
 * result type, so a consumer that needs one fails to typecheck until it opts in.
 *
 * Scope is deliberately narrow: credentials, credential digests, ciphertext and its IV/auth tag,
 * private-key material and wrapped data keys, and the settings:manage-gated folder access rules. It is
 * a backstop for "a write path returned the whole row", not a response serializer.
 *
 * `omit.spec.ts` parses `prisma/schema.prisma` and fails when a column whose name looks secret is
 * neither listed here nor on its commented allowlist. Add a new secret column here in the same change
 * that adds it to the schema.
 *
 * Raw SQL (`$queryRaw`) is NOT covered: it returns whatever the SQL selects.
 */
export const PRISMA_GLOBAL_OMIT = {
  // argon2id PHC hash (ADR-0086). Read only by the local-credential verify/rotate paths.
  user: { passwordHash: true },
  // Digest of the service-account bearer token (ADR-0048). Read only by token verification.
  serviceAccount: { tokenHash: true },
  // Single-use reset-token digest (ADR-0086). Read only by the reset-token lookup.
  passwordResetToken: { tokenHash: true },
  // OAuth 2.1 code / token digests (ADR-0097). Looked up by `where`, never read back.
  oAuthAuthorizationCode: { codeHash: true },
  oAuthToken: { tokenHash: true },
  // AES-256-GCM envelopes of instance secrets (ADR-0054 §5, ADR-0079, ADR-0091, ADR-0097). Read only
  // to decrypt.
  smtpSettings: {
    passwordCiphertext: true,
    passwordIv: true,
    passwordAuthTag: true,
  },
  directoryConnection: {
    bindPasswordCiphertext: true,
    bindPasswordIv: true,
    bindPasswordAuthTag: true,
  },
  aiSettings: { apiKeyCiphertext: true, apiKeyIv: true, apiKeyAuthTag: true },
  workflowSecret: { ciphertext: true, iv: true, authTag: true },
  // Secret-manager envelopes and key material (ADR-0061, ADR-0066, ADR-0080). Read only to decrypt or to hand the
  // caller its OWN encrypted key / wrapped DEK for client-side unlock.
  secretItem: { ciphertext: true, iv: true, authTag: true },
  vaultMembership: { wrappedDek: true },
  serviceAccountVaultMembership: { wrappedDek: true },
  userKeypair: {
    privateKeyEncByPassphrase: true,
    passphraseIv: true,
    privateKeyEncByRecovery: true,
    recoveryIv: true,
  },
  serviceAccountKeypair: {
    privateKeyEnc: true,
    privateKeySalt: true,
    privateKeyIv: true,
  },
  // KB folder access rules are gated to settings:manage (ADR-0060 §3, SEC-087).
  articleCategory: { accessRules: true },
} as const satisfies Prisma.GlobalOmitConfig;

export type PrismaGlobalOmit = typeof PRISMA_GLOBAL_OMIT;

/** The application's Prisma client type: the generated client with {@link PRISMA_GLOBAL_OMIT}. */
export type AppPrismaClient = PrismaClient<never, PrismaGlobalOmit>;

/**
 * The interactive-transaction client of {@link AppPrismaClient}. Use this instead of
 * `Prisma.TransactionClient`, which is typed WITHOUT the global omit and would claim the omitted
 * columns are present when at runtime they are not.
 */
export type AppTransactionClient = Omit<
  AppPrismaClient,
  runtime.ITXClientDenyList
>;

/** A model row as the app client returns it by default: the generated row minus its omitted columns. */
export type OmittedRow<
  M extends keyof PrismaGlobalOmit,
  Row extends object,
> = Omit<Row, keyof PrismaGlobalOmit[M]>;

/**
 * A `User` row without `passwordHash` — what every default query returns, and what the authenticated
 * principal (`request.user`, `@CurrentUser()`) carries. The hash is read only by a dedicated credential
 * read (`readPasswordHash`), never off the principal.
 */
export type UserRow = OmittedRow<'user', User>;

/** A `ServiceAccount` row without `tokenHash` — what the service principal carries. */
export type ServiceAccountRow = OmittedRow<'serviceAccount', ServiceAccount>;

/** The `omit` argument that opts one model's globally omitted columns back in. */
export type IncludeOmitted<M extends keyof PrismaGlobalOmit> = {
  readonly [K in keyof PrismaGlobalOmit[M]]: false;
};

/**
 * `omit: includeOmitted('smtpSettings')` re-includes EVERY globally omitted column of that model, for
 * the internal reads that genuinely need them (decrypt, verify, key loading). Using it instead of a
 * hand-written `{ col: false }` keeps the opt-in complete when a column is added to the omit list.
 * Never use it on a read whose result is returned to a client.
 */
export function includeOmitted<M extends keyof PrismaGlobalOmit>(
  model: M,
): IncludeOmitted<M> {
  return Object.fromEntries(
    Object.keys(PRISMA_GLOBAL_OMIT[model]).map((col) => [col, false]),
  ) as IncludeOmitted<M>;
}
