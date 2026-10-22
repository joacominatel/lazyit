---
title: "ADR-0105: Client-level Prisma omit for secret and gated columns"
tags: [adr, api, prisma, security, serialization]
status: accepted
created: 2026-10-21
updated: 2026-10-21
deciders: [Joaquín Minatel]
---

# ADR-0105: Client-level Prisma omit for secret and gated columns

## Status

accepted — 2026-10-21, #1518. The CEO chose the client-level `omit` plus a CI spec over the schema,
and deferred a global response serializer. Closes the follow-up named in
[[SEC-085-user-credential-columns-serialized|SEC-085]] and [[SEC-087-kb-folder-writes-return-access-rules|SEC-087]].
Builds on [[0003-prisma-orm]] and [[0032-soft-delete-middleware]]; leaves
[[0018-api-documentation-swagger]]'s deferral of `ZodSerializerInterceptor` in place.

## Context

The API has no runtime response serializer. `@ApiOkResponse` is Swagger metadata only, so any path
that returns a Prisma row without a `select` sends every column. SEC-085 (`passwordHash` on user
reads) and SEC-087 (folder `accessRules` on folder writes) were both this class, and both were fixed
locally with an allowlist `select`. The #1518 audit read all 69 controllers and about 230 write routes:
no other route exposes a gated column under the default matrix today, but nothing stops the next one.

The columns that must never ride along are few and easy to name: credential hashes, token and code
digests, AES-GCM ciphertext with its IV and auth tag, wrapped private keys and data keys, and the
`settings:manage`-gated folder access rules.

## Considered options

- **A global nestjs-zod serializer** (`ZodSerializerInterceptor` + `@ZodResponse`). It only acts on
  annotated routes, so about 319 routes would need annotating. The shared schemas declare
  `z.iso.datetime()` while Prisma returns `Date`, so every schema needs a codec, and a mismatch on
  legacy data becomes a 500. It also reshapes the AI tool and MCP responses, which dispatch through the
  same controllers. Large, risky, and not what the bug class needs first.
- **Per-module `select` allowlists only.** What SEC-085 and SEC-087 did. Fixes one route at a time,
  and CI cannot tell when a new route forgets one.
- **A client-level `omit` (Prisma 7 global omit) for the secret columns, plus a CI spec.** Chosen.

## Decision

1. **One exported constant**, `PRISMA_GLOBAL_OMIT` in `apps/api/src/prisma/prisma-omit.ts`, lists
   the omitted columns. `PrismaService` is built with it, and so are the sandboxed BullMQ processors'
   own clients. Today it covers `User.passwordHash`, `ServiceAccount.tokenHash`,
   `PasswordResetToken.tokenHash`, `OAuthAuthorizationCode.codeHash`, `OAuthToken.tokenHash`, the
   `*Ciphertext`/`*Iv`/`*AuthTag` envelopes of `SmtpSettings`, `DirectoryConnection` and `AiSettings`,
   `WorkflowSecret` and `SecretItem` `ciphertext`/`iv`/`authTag`, both `wrappedDek` columns, the
   private-key columns and their IVs on `UserKeypair` and `ServiceAccountKeypair`, and
   `ArticleCategory.accessRules`.
2. **Opt back in only where the column is genuinely needed**, with `omit: { col: false }`, with
   `includeOmitted('<model>')` (every omitted column of that model), or with a `select` that names the
   column. The opt-ins are: the login lookup and the step-up verifier's credential read
   (`readPasswordHash`), the service-account bearer check, the OAuth/MCP token verification and
   exposed-token revocation, the SMTP, directory, AI-provider and workflow-secret decryption, the
   `*Set` flags those settings report, and every secret-manager response that hands a member their own
   envelope, wrapped DEK or wrapped private key for client-side decryption. Folder rules were already
   read through explicit selects.
3. **The authenticated principal carries no hash.** `request.user`, `@CurrentUser()` and the service
   principal are typed as `UserRow` / `ServiceAccountRow` (the generated row minus its omitted
   columns). A path that must check a password reads the hash by id, uses it once, and drops it.
4. **The type follows the runtime.** `PrismaService` is typed with the omit config, so an omitted
   column disappears from every root-client result type and a consumer that needs it fails to
   typecheck until it opts in.
5. **CI spec.** `prisma-omit.spec.ts` parses `prisma/schema.prisma` and fails when a scalar column
   whose name matches `/hash|token|cipher|iv$|authTag|secret|privateKey|wrappedDek|accessRules/i` is
   neither omitted nor on a commented allowlist (token budgets, content digests, a foreign key, a
   display prefix). It also fails on a stale omit entry. Unit specs that run a module end to end wrap
   their Prisma mock in `withGlobalOmit` (`apps/api/test/prisma/global-omit.ts`) so a missed opt-in
   fails the spec, and `test/prisma-global-omit.db.spec.ts` pins the real client's behaviour.
6. **Not a serializer.** Non-secret columns are still returned as they are today. A response
   serializer (`@ZodResponse` with codecs, added route by route) stays a possible later step.

## Consequences

- **Positive:** the bug class behind SEC-085 and SEC-087 is closed on every Prisma code path, not
  route by route, and the CI spec catches the next secret column the day it is added. No migration, no
  stored data touched, and no non-secret response field changes.
- **Negative / trade-offs:**
  - **The interactive-transaction client is not typed with the omit.** Prisma 7 types the
    `$transaction(async (tx) => …)` callback with the default client, so a read inside a transaction
    still type-checks as if the column were there while at runtime it is absent. The opt-ins inside
    transactions were found by grepping every omitted column name and are covered by tests; the type
    gap remains until the ~70 `Prisma.TransactionClient` annotations move to `AppTransactionClient`.
  - A missed opt-in is an outage, not a leak: login, token checks, decryption or a vault unlock stop
    working. That is the reason for the `withGlobalOmit` specs and the DB spec.
  - Raw SQL (`$queryRaw`) is not covered. Today no raw query selects an omitted column.
  - The step-up verifier and the OAuth consent's password check now do one extra indexed read by id.
- **Follow-ups:** retype `Prisma.TransactionClient` to `AppTransactionClient` once the concurrent work
  on those services lands; consider `@ZodResponse` with codecs incrementally.
