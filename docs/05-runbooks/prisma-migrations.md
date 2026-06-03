---
title: Prisma Migrations
tags: [runbook, database]
status: accepted
created: 2026-05-26
updated: 2026-05-26
---

# Runbook — Prisma migrations

How to evolve the database schema in lazyit. Every command runs **inside `apps/api`** (where
`prisma.config.ts` and `prisma/schema.prisma` live). Background: [[0003-prisma-orm]], [[setup]].

> [!info] Two states must always agree
> `prisma/schema.prisma` (desired) ↔ `prisma/migrations/**` (history) ↔ the live database.
> Every procedure below ends by checking they're in sync.

## Naming convention

Migrations are named `snake_case`, **verb + noun**, describing the change:
`add_location_model`, `add_external_id_to_users`, `add_asset_cluster`,
`add_asset_assignment_model`. One change per migration.

## 1. Normal flow (interactive shell, with a TTY)

```bash
cd apps/api
bunx prisma migrate dev --name <descriptive_name>
```

`migrate dev` diffs the schema, writes `prisma/migrations/<timestamp>_<name>/migration.sql`,
applies it, regenerates the client, and runs the seed. This is the **default** — use it whenever
you have a real terminal.

## 2. Non-TTY workaround (agent / CI / no prompt available)

### Why it happens

`migrate dev` is **interactive**: it pauses to confirm anything it considers risky and aborts when
it can't prompt. Common triggers:

- **Schema drift** — the DB doesn't match the migration history, so it offers to **reset**
  (wipes data). It will not do that unattended.
- **Potentially destructive / ambiguous change** — e.g. adding a `UNIQUE` constraint on a column
  that may already hold duplicates, or adding a required column to a non-empty table.
- **No TTY at all** (this agent, CI runners) — there's nothing to read the prompt, so it errors out
  instead of applying.

### The recipe — generate the SQL, then `migrate deploy`

`migrate deploy` is **non-interactive**: it applies every pending migration in
`prisma/migrations/` and records them in `_prisma_migrations`. So we generate the SQL ourselves
and let `deploy` apply it.

```bash
cd apps/api

# (a) Edit prisma/schema.prisma — add/modify the model(s).

# (b) Generate the forward SQL (live DB -> desired schema):
bunx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script > /tmp/forward.sql

# (c) Create the migration folder by hand and move the SQL in. Use a UTC-ish timestamp
#     that sorts AFTER the last migration (YYYYMMDDHHMMSS_<name>):
mkdir -p prisma/migrations/20260526120000_add_example_model
mv /tmp/forward.sql prisma/migrations/20260526120000_add_example_model/migration.sql

# (d) Hand-edit migration.sql if you need SQL Prisma can't express (see §3).

# (e) Apply it non-interactively + regenerate the client:
bunx prisma migrate deploy
bunx prisma generate

# (f) Verify (see §6).
```

> [!tip] Cleaner variant when a TTY *almost* works
> `bunx prisma migrate dev --name <name> --create-only` writes the migration **without applying
> it**, so you can hand-edit the SQL and then `migrate deploy`. If even `--create-only` aborts
> (pure non-TTY), fall back to the `migrate diff` path above.

## 3. SQL Prisma can't express (partial indexes, etc.)

Some Postgres features have **no PSL syntax** — most notably **partial unique indexes**
(`CREATE UNIQUE INDEX … WHERE …`). For these:

1. Declare what you *can* in `schema.prisma` (plain `@@index`) and leave a comment pointing here.
2. Append the raw statement to the migration's `migration.sql` by hand.

Real example — "at most one **active** assignment per `(asset, user)`"
([[asset-assignment]], [[0019-asset-assignment-integrity]]). Columns are **camelCase** (lazyit
maps only table names via `@@map`, not columns):

```sql
CREATE UNIQUE INDEX "asset_assignments_assetId_userId_active_key"
  ON "asset_assignments"("assetId", "userId")
  WHERE "releasedAt" IS NULL;
```

The same pattern carries the soft-delete-reuse partial uniques ([[0041-soft-delete-reuse-and-restore]])
and, for [[article-link]] ([[0042-article-versioning-and-linking]]), **both** a CHECK constraint
(exactly-one-target) and two partial uniques (no duplicate link per target) — a CHECK has no PSL
syntax either:

```sql
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_exactly_one_target"
  CHECK ((("assetId" IS NOT NULL)::int + ("applicationId" IS NOT NULL)::int) = 1);
CREATE UNIQUE INDEX "article_links_article_asset_key"
  ON "article_links" ("articleId", "assetId") WHERE "assetId" IS NOT NULL;
CREATE UNIQUE INDEX "article_links_article_application_key"
  ON "article_links" ("articleId", "applicationId") WHERE "applicationId" IS NOT NULL;
```

For service accounts ([[0048-service-accounts]]) the `add_service_accounts` migration carries a
soft-delete-reuse **partial unique** on `tokenHash` and an **at-most-one-actor CHECK** (`<= 1`, human
XOR service-account) on each of the 6 audit-bearing tables — `AssetAssignment` and `AccessGrant` carry
two actor slots each, so they get one CHECK per slot:

```sql
CREATE UNIQUE INDEX "service_accounts_tokenHash_live_key"
  ON "service_accounts" ("tokenHash") WHERE "deletedAt" IS NULL;
ALTER TABLE "asset_history" ADD CONSTRAINT "asset_history_one_actor"
  CHECK ((("performedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);
-- …and likewise for consumable_movements, article_versions, article_links, plus
-- asset_assignments (assigned/released) and access_grants (granted/revoked), one CHECK per actor slot.
```

> [!note] Prisma does not manage what it can't represent
> A partial index lives only in the migration SQL. Prisma can't model it, so it neither emits it
> on `migrate diff` nor reports it as **drift** — the `--exit-code` check in §6 stays green. The
> trade-off: the index is invisible to the schema; document it where the model is defined.

## 4. Resetting the dev database (destructive — dev only)

```bash
bunx prisma migrate reset   # drops, recreates, replays all migrations, reseeds
```

Wipes **all data**. Only ever on a local dev database — **never** against anything worth keeping
(staging/prod). For production rollouts use `migrate deploy` (see the Deploy runbook when it
exists — [[deployment]]).

## 5. Regenerate the client without migrating

After pulling schema changes or editing the generator, refresh the generated client
(`apps/api/generated/prisma`) without touching the DB:

```bash
bunx prisma generate
```

## 6. Verify there's no drift

```bash
bunx prisma migrate status        # are all migrations applied? any drift vs the DB?

# Does the live DB match schema.prisma? exit 0 = in sync, 2 = differs (drift), 1 = error:
bunx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code
```

Expected after a successful migration: `migrate status` reports the DB is up to date, and the
`--exit-code` diff prints **"No difference detected."** (exit 0).

## 7. Commit convention — one commit per migration

A migration is **atomic**: the generated `migration.sql` **and** the `schema.prisma` change are
meaningless apart, so they go in **one commit** together (the only sanctioned exception to
lazyit's one-file-per-commit rule — see [[claude-workflow]]). Prefix `feat`/`updt` per the change;
keep `prisma generate` output (`apps/api/generated/`) out of the commit — it's reproducible.

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/<ts>_<name>/migration.sql
git commit -m "feat: add <name> migration and model"
```

Related: [[setup]] · [[workflows]] · [[0003-prisma-orm]] · [[conventions]] ·
[[0006-soft-delete-and-auditing]] · [[asset-assignment]]
