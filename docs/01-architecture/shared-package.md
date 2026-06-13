---
title: The @lazyit/shared Package
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-06-13
---

# The `@lazyit/shared` Package

`packages/shared` (`@lazyit/shared`) is the **single source of truth for everything `web`
and `api` must agree on**. This note is the contract for what may live here — keep it tight
so the package doesn't become a junk drawer.

> Today it exports `APP_NAME`, the per-entity zod schemas/types across the domain (User, Asset,
> Location, Application, AccessGrant, Consumable, Article, …), the `Page<T>`/`PageQuery` list envelope,
> the per-entity `clone/` sanitizers, the **auth/authZ contract**: the frozen `Permission` catalog
> + `RolePermissionMatrix` + `DEFAULT_ROLE_PERMISSIONS` ([[role-permission]], [[0046-roles-permissions-v2]])
> and the `ServiceAccount` schemas ([[service-account]], [[0048-service-accounts]]), and the
> **Applications Workflow Engine contract** (`schemas/workflow.ts` — [[0054-applications-workflow-engine]]).
> The contract below governs what gets added.

## The boundary rule

> [!important] Litmus test
> **If both `web` and `api` must agree on its shape or behavior → it belongs in `shared`.
> If only one side needs it → it stays in that app.**

`shared` is the monorepo **leaf**: it depends on nothing in the repo, and nothing about a
specific framework. Apps depend on it via `workspace:*`, never the reverse ([[monorepo]]).

## What belongs here

- **Zod schemas** — the source of truth for validation. The API validates DTOs against them;
  the web validates forms against them. (Per [[0007-flexible-asset-specs-jsonb]], per-category
  asset `specs` schemas live here too.)
- **Types & interfaces** — preferably **inferred** from the zod schemas (`z.infer<...>`), plus
  hand-written shared types where there's no schema.
- **Enums & constants** — shared status vocabularies, ticket priorities, role names, etc.
- **Pure, framework-agnostic utilities** — small pure functions used by both sides
  (formatting, parsing, computed values like deriving stock from movements). No side effects.

> [!note] The auth/authZ contract (Roles & Permissions v2 + Service Accounts)
> `packages/shared/src/schemas/permission.ts` is the **single source of truth** for authorization
> shared by `api` (seed + guard + config endpoints) and `web` (the matrix editor + `can()`):
> - `PermissionSchema` / `PERMISSIONS` — the **frozen, closed** catalog of `domain:action` literals
>   (~33). Catalog-as-code: a typo can't mint a permission, CI fails on an unknown literal.
> - `Permission` (inferred type), `RolePermissionMatrix` (`Record<Role, Permission[]>` wire shape),
>   `DEFAULT_ROLE_PERMISSIONS` (the seeded matrix — consumed by both the seed and the golden test, so
>   the documented matrix and the seeded rows can never drift).
> - `UpdateRolePermissionsSchema` (the strict `PUT /config/permissions` body — MEMBER/VIEWER keys only;
>   ADMIN immutable).
> - The **human layer** — `PERMISSION_META` / `CAPABILITIES` / presets — the catalog's structure (ids,
>   pillars, tiers, capability/preset bundling), guarded by a covering-set test so it can't drift from the
>   machine catalog. Its English `label`/`description` strings are the **default copy**, but the editor no
>   longer renders them directly: the user-facing labels are localized in the web i18n catalog
>   (`apps/web/messages/{en,es}/settings.json` under `permissionMeta.*`), keyed by the SAME ids and
>   resolved at the render sites (issue #215, [[0051-i18n-next-intl|ADR-0051]]) — so `shared` stays a
>   framework-agnostic leaf (no React, no next-intl) and the contract values are unchanged.
> - `ServiceAccountSchema` (no secret — `tokenPrefix` only), `CreateServiceAccountSchema`,
>   `UpdateServiceAccountSchema`, and the **once-only** `ServiceAccountWithSecretSchema`; permissions
>   validated against the same `PermissionSchema`. See [[role-permission]] · [[service-account]] ·
>   [[authorization]].

> [!note] The Applications Workflow Engine contract
> `packages/shared/src/schemas/workflow.ts` is the **single front↔back contract** for the engine
> ([[0054-applications-workflow-engine]]), consumed by `api` (the executor + definition/run/task
> endpoints) and `web` (the box-diagram DAG builder + run timeline). It holds:
> - the **enums** — triggers (`ACCESS_GRANTED` / `ACCESS_REVOKED` v1), connector/step `kind`, run /
>   step / manual-task status, deprovision policy, HTTP method, retry backoff, and the transition
>   terminals (`END_SUCCESS` / `ESCALATE_TO_MANUAL` / `COMPENSATE` / `STOP_FAIL`);
> - the **discriminated unions** keyed on `kind` — `WorkflowConnectionConfigSchema` and
>   `WorkflowStepSchema` (REST / WEBHOOK_OUT / MANUAL), plus the per-step success-criteria, retry and
>   `onSuccess`/`onFailure` edge dimensions of the opinionated error-handling DAG;
> - the **pure classifiers** both sides share so the executor and the builder preview can never drift —
>   `isHttpStatusSuccess(status, criteria?)` and `resolveStepTransitions(steps, index)` (the single
>   source of truth for the graph walk);
> - the **entity wire DTOs**. **Secrets never appear on a wire shape** — the read side exposes only a
>   redacted `configured` descriptor (the [[service-account]] `tokenPrefix` pattern). Like the rest of
>   `shared` it stays a framework-agnostic leaf: no Prisma, no NestJS, no React.

> [!note] Secret Manager shared material — as-built (#366, ADR-0061)
> [[0061-secret-manager-zero-knowledge]] added two layers of shared Secret Manager material, both
> consistent with the boundary rule above:
>
> **Main barrel (`@lazyit/shared`)** — pure zod schemas and inferred types, no crypto:
> - `schemas/secret-vault.ts`, `schemas/secret-item.ts`, `schemas/vault-membership.ts`,
>   `schemas/user-keypair.ts` — the wire-shape DTOs (base64 string blobs + metadata). No `@noble/*`.
>   Safe for `apps/api`'s CommonJS Jest to load via the main barrel.
> - The **recovery-key zod validator** (Crockford-base32 format `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`) and
>   the `{{ lazyit_secret.HANDLE }}` chip reference format are validated via schemas in this main barrel.
>
> **Subpath (`@lazyit/shared/crypto`)** — pure, framework-agnostic crypto primitives:
> - `packages/shared/src/crypto/` exports X25519/ECDH key generation, HKDF-SHA-256, AES-256-GCM
>   envelope split/join (the `WorkflowSecret`-identical ciphertext+authTag layout), Argon2id parameter
>   constants, and Crockford-base32 recovery-key encode/decode.
> - Imported as `@lazyit/shared/crypto` (a `package.json` subpath export — `dist/crypto/index.js`).
> - **No `window`, no DOM, no `.wasm`** — the WASM boundary is in `apps/web` (the Argon2id WASM
>   wrapper `hash-wasm` is a `apps/web`-only dependency). The subpath is intentionally **excluded from
>   the main barrel** (`src/index.ts` does NOT re-export it) because `@noble/*` is ESM-only: pulling it
>   into the main barrel would break `apps/api`'s CommonJS Jest across every suite that touches the barrel.
>   `apps/api` is a ciphertext custodian and never needs these primitives.
> - Follow-up **#429** tracks formally shipping the subpath as an ESM module type.
>
> The wrapped DEK blobs, keypair crypto, and all decrypt/unwrap operations stay client-side in
> `apps/web` — they never enter `shared` beyond the pure-function primitives above. The zero-knowledge
> contract is in [[0061-secret-manager-zero-knowledge]] and [[secret-manager-crypto-design]].

## What does NOT belong here

- **Framework code** — React components/hooks, Next-specific code, NestJS providers/decorators.
- **Anything importing from `apps/web` or `apps/api`** — that inverts the dependency.
- **Prisma / database types** — those are an API concern; they stay in `apps/api`.
- **Environment / config access, I/O, side effects** — `shared` is pure and deterministic.
- **Heavy dependencies** — keep deps minimal (zod is the expected one).

## Conventions

- **Strict TypeScript**, **built** with `tsc -p tsconfig.build.json` to `dist/` (CommonJS +
  `.d.ts`); `main`/`types`/`exports` point at `dist/`. The base `tsconfig.json` stays no-emit
  (editor / Bun). Turbo runs the build before dependents (`build`/`dev`/`test` `dependsOn`
  `^build`). Why a build (and not source-direct): [[0014-shared-package-build]].
- Organize `src/` by kind — `schemas/` (zod + inferred types), `constants/`, `utils/` (pure fns),
  `clone/` (the per-entity "clone a record" sanitizers — pure mappers from a persisted record to a
  `CreateX`-shaped partial, used to pre-fill the create forms) — then re-export from the barrel
  `src/index.ts` (extensionless imports); import as `@lazyit/shared`.
- Validation flow: define the **zod schema here** → API uses it for request validation, web
  uses it for forms → share the type via `z.infer`. One definition, no duplication.
- Tests for `shared` run with `bun test` ([[0012-testing-strategy]]).

Related: [[monorepo]] · [[code-conventions]] · [[authorization]] · [[role-permission]] ·
[[service-account]] · [[0007-flexible-asset-specs-jsonb]] · [[0012-testing-strategy]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0054-applications-workflow-engine]]
