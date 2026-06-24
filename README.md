<p align="center">
  <img src="brand/lazyit-github-readme.png" alt="lazyit — asset-centric IT operations" width="720">
</p>

<p align="center">
  <strong>The IT inventory & access tool small teams actually want to open.</strong><br/>
  Self-hosted. Asset-centric. Auditable by default.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <img alt="Status: MVP" src="https://img.shields.io/badge/status-MVP-orange.svg">
  <img alt="Self-hosted" src="https://img.shields.io/badge/deploy-self--hosted-success.svg">
  <img alt="Stack" src="https://img.shields.io/badge/stack-Next.js%20%C2%B7%20NestJS%20%C2%B7%20Postgres-1f6feb.svg">
</p>

---

## Demo

<p align="center">
  <video src="https://github.com/joacominatel/lazyit/raw/master/brand/video.mp4" controls width="820"></video>
</p>

<p align="center">
  <em>▶ <a href="brand/video.mp4">Watch the demo</a> — a quick tour of lazyit (inventory, access, knowledge base and the secret manager).</em>
</p>

---

## What is lazyit?

If you're 5–20 people who own *all* of a company's technology — the laptops, the
switches, the SaaS seats, the licenses, the cables and the toner — you already know the
problem. "What do we have, where is it, and who can touch it?" lives in three spreadsheets,
someone's memory, and a chat history nobody can search. People rotate; the knowledge of who
owned what walks out the door with them.

**lazyit is the single place to keep all of it.** Asset inventory, application access,
consumables, a knowledge base and an encrypted credential vault — built *around IT objects*,
not a generic ticketing tool bent into shape. Think ServiceNow-grade capability, minus the
enterprise weight and the price tag, in something modern you'll actually want to use.

Two ideas run through everything:

- **Asset-centric.** The **asset** is the first-class citizen, not the user. Assets persist;
  people come and go. Ownership is a timestamped relationship, never a column — so the history
  of "who had this, and when" is automatic and never lost.
- **Auditable by default.** Nothing is hard-deleted (soft delete everywhere), and the history
  ledgers are append-only. "What changed, when, by whom?" always has an answer.

It's **self-hosted and single-org** by design — your inventory and access data is sensitive,
and it should live inside your company, on infrastructure a small team can actually operate
for years. Boring, durable technology. No Kubernetes required.

> [!NOTE]
> **The full documentation is an Obsidian vault in [`docs/`](docs/README.md) — and it's the
> source of truth.** This README is the front door; `docs/` is the house. When the two
> disagree, the docs win. Start at [`docs/README.md`](docs/README.md).

---

## Screenshots

<p align="center">
  <em>Dark mode · expand a view below to browse.</em>
</p>

<details open>
<summary><strong>Dashboard</strong> — pillar cards, live activity feed, and estate snapshot</summary>
<br/>
<p align="center">
  <img src="brand/dashboard.png" alt="lazyit dashboard — Assets, Access, Knowledge and Consumables at a glance" width="920">
</p>
</details>

<details>
<summary><strong>Assets</strong> — search, filter, and manage the full inventory</summary>
<br/>
<p align="center">
  <img src="brand/assets-page.png" alt="lazyit assets page — inventory table with status, owners, and locations" width="920">
</p>
</details>

<details>
<summary><strong>Reports</strong> — estate-wide activity history with filters and export</summary>
<br/>
<p align="center">
  <img src="brand/reports.png" alt="lazyit reports — timeline of who did what, when" width="920">
</p>
</details>

<details>
<summary><strong>Offboarding</strong> — guided handover, assets to return, and a printable act</summary>
<br/>
<p align="center">
  <img src="brand/offboard-user.png" alt="lazyit offboarding — asset return checklist and handover note" width="920">
</p>
</details>

---

## What it does today

Honest scope: this is what's **built and usable right now**, not a wishlist.

- 📦 **Assets & inventory** — the heart of it. Flexible, type-specific specs (laptops,
  servers, switches, licenses…), categories and models, locations, and a **timestamped
  assignment history** so ownership is never a guess. Assets get **automatic, configurable
  tags** (e.g. `SRV#1010`) from a tag scheme you control.
- 🔑 **Application access** — register the apps and SaaS you run, then grant and (critically)
  **revoke** access per user, with a map of who can touch what.
- ⚙️ **Applications Workflow Engine** *(opt-in, per app)* — when access is granted or revoked,
  admin-built **workflows** can provision/deprovision the user in external systems (Jira,
  Redmine, any REST or webhook target). You wire them in a **visual box-diagram builder** with
  retries, success/failure paths, manual (human) steps, a test-connection check and a
  no-side-effects **dry-run**. An app with no workflow behaves exactly as before — the engine
  fires *after* the grant commits, so a failing external call never blocks it.
- 🔐 **Secret Manager** — encrypted **credential vaults** beside the knowledge base, where the
  server can **never** read your secrets (zero-knowledge: everything is encrypted and decrypted
  in your browser). Share a vault with teammates, rotate access, recover with a one-time key.
- 🧰 **Consumables** — stock you burn through (cables, toner, adapters) tracked as an
  **append-only movement ledger**, so counts are always reconcilable.
- 📚 **Knowledge base** — internal articles in **folders**, with versioning, `[[wiki-links]]`
  and backlinks, full-text search, and bulk `.zip` / `.docx` import. Per-folder access control
  for the runbooks that shouldn't be public to the whole team.
- 🛡️ **Roles & permissions** — three fixed roles (`ADMIN` / `MEMBER` / `VIEWER`), but **what
  each role grants is configurable** by an admin from a closed permission catalog. Permissions
  are stored in lazyit and **never synced to your IdP**, so they survive a bring-your-own-IdP swap.
- 🤖 **Service accounts** — first-class **non-human** credentials for automation (CI, scripts,
  integrations): a lazyit-native token (`lzit_sa_…`, hashed at rest, shown once), authorized by
  explicit permission grants, **never** ADMIN, **fail-closed**.
- 📊 **Reports** — an estate-wide, filterable **activity history**: who did what, to which
  entity, when — with CSV and print export.
- 🧾 **Printable offboarding act** — generate a clean hand-over sheet when an asset or a person
  leaves.
- 📖 **In-app Manual** — a built-in `/help` manual that documents lazyit itself, in **English
  and Spanish**.

The whole UI is available in **English and Spanish**. Authentication is **OIDC** against a
self-hosted identity provider: **Zitadel is bundled**, and because everything speaks standard
OIDC you can **bring your own IdP** (Azure AD, Okta, Keycloak, Authentik…) by changing a few
env vars — no code changes.

---

## Quick start

There are two ways in: **self-host the whole thing** (the friendly one-command path), or
**run it for development**.

### Self-host it (recommended for trying it for real)

Everything runs in Docker behind [Caddy](https://caddyserver.com/) with automatic HTTPS. The
friendliest first boot is [`infra/start.sh`](infra/start.sh) — a guided, **idempotent and
non-destructive** wrapper. It checks your environment, asks ~6 questions, generates a secrets
file with strong random values (`chmod 600`), brings the stack up, and points you at the in-app
`/setup` wizard to create the first admin.

```sh
git clone https://github.com/joacominatel/lazyit.git
cd lazyit
./infra/start.sh             # interactive, guided (recommended)
# then open the URL it prints and go to /setup
```

```sh
./infra/start.sh --yes       # non-interactive localhost defaults (smoke test)
./infra/start.sh --dry-run   # run every check, write nothing, start nothing
```

You'll need **Docker + Docker Compose v2** and **OpenSSL**. ~4 GB RAM and 20 GB free disk is a
comfortable floor (the stack runs Postgres, Valkey, Meilisearch and a bundled Zitadel).
Full runbook: [`docs/05-runbooks/deploy-self-hosted.md`](docs/05-runbooks/deploy-self-hosted.md).

> [!IMPORTANT]
> **Back up the generated `infra/env/.env.prod` off-host, encrypted.** It holds the
> unrotatable `ZITADEL_MASTERKEY` and the key that encrypts stored credentials — lose it and a
> restored backup can't be decrypted. `start.sh` never regenerates or overwrites it.

### Run it for development

The fast, native loop: backing services in Docker, the apps on your machine via
[Bun](https://bun.sh). You'll need **Bun `1.3.x`** (the repo pins `1.3.14`), **Docker**, and
**Node** on your PATH.

```sh
bun install                              # install every workspace

cp .env.example .env                     # root: Postgres, Meili, dev Zitadel
cp apps/api/.env.example apps/api/.env   # api:  DATABASE_URL, PORT, auth
cp apps/web/.env.example apps/web/.env   # web:  API URL + Auth.js vars

bun run db:up                            # start Postgres + Meili + Zitadel in Docker

cd apps/api && bunx prisma migrate dev && bunx prisma db seed && cd -   # migrate + seed

bun run dev                              # web → http://localhost:3000 · api → http://localhost:3001
```

API docs (Swagger) live at **http://localhost:3001/api/docs**. Other scripts: `bun run build`
· `bun run lint` · `bun run test` · `bun run db:down`. Full walkthrough, env reference and the
Prisma workflow: [`docs/04-development/setup.md`](docs/04-development/setup.md).

> [!NOTE]
> Local dev can use a zero-config auth **shim** (`AUTH_MODE=shim`) that trusts an `X-User-Id`
> header instead of validating tokens, so you can run the whole stack without bootstrapping
> Zitadel. The shim is **dev/test only — it must never run in production.**

---

## How it's built

Two apps that never import each other — they talk over HTTP — plus a shared contract package,
all behind a single reverse proxy in production:

- **`apps/web`** — Next.js (App Router) + React + Tailwind v4. The UI you actually use.
- **`apps/api`** — NestJS + Prisma on PostgreSQL. The brain. Async background work (the workflow
  engine, `.docx` import) runs on **BullMQ over Valkey**, under the rule *"BullMQ executes,
  PostgreSQL remembers."*
- **`packages/shared`** — `@lazyit/shared`: the zod schemas and types both apps agree on, so
  there's one definition of every contract, not two that drift.

In production, only Caddy is exposed; Postgres, Valkey, Meilisearch, the API, the web app and
Zitadel all stay on an internal Docker network. The deep dive lives in
[`docs/01-architecture/`](docs/01-architecture/stack.md).

---

## How we work

lazyit is built in the open with a deliberately small, disciplined process. If you read one
thing before contributing, read [`docs/04-development/claude-workflow.md`](docs/04-development/claude-workflow.md)
and the [git workflow runbook](docs/05-runbooks/git-workflow.md).

- **Branches.** `master` is production (protected). `dev` is integration — every change lands
  there first. Work happens on issue branches cut from `dev`, named
  `<prefix>/issue-<n>-<slug>`.
- **One feature, one issue, one branch, one PR → `dev`.** Start by finding or opening the
  GitHub issue, branch off `dev`, and open the PR against `dev` when it's ready. `dev` is
  promoted to `master` as its own reviewed step.
- **Small commits.** One file per commit where it makes sense (docs may be grouped). Commit
  messages use a short prefix: `feat` · `fix` · `chore` · `del` · `updt` · `docs`.
- **Docs stay in sync.** A change to core logic updates the `docs/` vault in the same change;
  a user-facing change updates the in-app `/help` Manual (English **and** Spanish) too. A
  feature isn't done until its docs are.

### Contributing

This is currently a **personal project**, validated internally before any wider release, so
there's no formal contributor process yet. If you want to use it, fork it, or report something:
open a [GitHub issue](https://github.com/joacominatel/lazyit/issues) — bug reports, questions
and ideas are all welcome. If you send a PR, target `dev`, keep it focused, and follow the
conventions above.

---

## Roadmap

Rough direction, not promises. Honest about what's **not** here yet:

- **Realtime.** Workflow runs and the manual-task inbox are **polled** today; a live
  notification stream (SSE / bell) is on the list.
- **More connectors.** The workflow engine ships REST / webhook / manual steps against public
  HTTPS targets; **on-prem/internal-target** connectors and **scheduled/timer triggers** are future.
- **Scheduled jobs from the app.** UI-triggered backups and low-stock consumable alerts aren't
  built yet — the queue substrate for them is now in place.
- **One-click restore & easier backups.** Backups are an opt-in `pg_dump` sidecar today; restore
  is still a manual runbook.
- **A delivery pipeline.** CI gates every PR (typecheck, lint, test, build, image build), but
  there's no published images or automated deploy target yet.

Deferred items are tracked in [`docs/`](docs/README.md) (the per-folder `_MOC.md` indexes and
the open ADRs).

---

## License

**[AGPL-3.0](LICENSE).** You're free to use, study, modify and self-host lazyit. The AGPL is a
strong copyleft license: if you modify lazyit and let others use it **over a network**, you
must make your modified source available to those users under the same license. See
[`LICENSE`](LICENSE) for the full terms.

© 2026 Joaquin Minatel.

---

## Documentation

The real documentation is the Obsidian vault in **[`docs/`](docs/README.md)** — vision and
problem-space, the architecture and stack, the asset-centric domain model, every ADR (the *why*
behind each decision), the setup guide, and the operations runbooks. **It's the source of truth;**
start at [`docs/README.md`](docs/README.md).

> [!NOTE]
> **Status:** lazyit is a personal project at the MVP stage — built in the open, finishing its
> refinement, and validated internally before any wider release. Expect rough edges, honest
> docs, and steady progress.
