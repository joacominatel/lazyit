---
title: Demo data generator
tags: [development, testing, tooling]
status: accepted
created: 2026-10-17
updated: 2026-10-17
---

# Demo data generator

`scripts/demo-data/seed.ts` fills a lazyit instance with realistic, high-volume mock data: thousands
of users and assets, access grants and requests in every state, consumables with a movement history,
purchases in every receipt state and a knowledge base several folders deep. It exists so a release
can be tested on a database that looks like a real one, at a realistic size (#1640).

## Why it goes through the API

The script signs in as an ADMIN with `POST /auth/login` and calls the same REST endpoints the web app
calls. It never writes to the database. Every domain rule, history row, ledger movement, audit entry,
notification and search-index update therefore happens exactly as in normal use, and a rule the API
enforces is enforced on the mock data too. A service account would not work: it is refused on
assignments, access requests and the tag scheme.

> [!danger] Mock data cannot be removed
> lazyit never hard-deletes ([[0041-soft-delete-reuse-and-restore]]): users are offboarded, assets
> archived, ledgers are append-only. There is no "undo" for a run. **Take a backup first**
> ([[backups]] → *Manual backup*) and restore it to roll back ([[backups]] → *Restore*).
> Run this against a test or home-lab instance, never against the one your team works in.

## Running it against a deployed instance

You need [Bun](https://bun.sh) and a checkout of this repository. Nothing has to be installed or
built: the script imports only types from `@lazyit/shared`, which Bun strips at runtime.

```bash
# 1. Back up first (docs/05-runbooks/backups.md, "Manual backup").
# 2. Turn outbound email off in Settings → Email, or accept the mail (see below).
export LAZYIT_URL="https://lazyit.example.com/api"   # the /api prefix is the API on a deployed instance
export LAZYIT_EMAIL="admin@example.com"              # an ADMIN account with a local password
read -rs LAZYIT_PASSWORD && export LAZYIT_PASSWORD   # typed, not echoed, not in shell history

bun scripts/demo-data/seed.ts --profile small        # a quick check first: about 5% of full
bun scripts/demo-data/seed.ts --profile full         # the full volume
```

`LAZYIT_URL` is the **API base**. Behind the bundled Caddy the API lives under `/api` on the same
origin as the web app (`https://<host>/api`, or `http://<host>/api` on a LAN install). In local
development the API is reached directly at `http://localhost:3001`. Pointing it at the web root
fails with a clear message instead of writing anything. An instance on Caddy's internal CA
(`https://localhost:8443`) needs that CA trusted: run `infra/trust-local-ca.sh`, or set
`NODE_EXTRA_CA_CERTS` to the exported root certificate.

Before the first write the script:

1. checks the account is an ADMIN;
2. reads the SMTP settings and **stops while outbound email is enabled**, unless `--allow-email`;
3. prints the target URL, the instance version, the signed-in account and every resolved count;
4. asks you to type `yes` (skip it with `--yes`; without a terminal, `--yes` is required).

The password and the session token are never printed. At the end the script ends its own session
only (not `POST /auth/logout`, which would sign the admin out of every device).

## Outbound email

Several of the actions the generator performs raise notifications, and with SMTP enabled some of them
become email ([[0079-instance-smtp-outbound-email]]). Broadcasts go to every holder of `notification:read`
(every ADMIN, including the mock ones); the decision nudge goes to the requester.

| Action in the run | Notification | Emailed to |
| --- | --- | --- |
| A grant on a critical application (Okta, CrowdStrike Falcon, AWS Production) | `critical_app_access` | every admin |
| A grant whose access level is `Admin` or `Administrator` | `admin_granted` | every admin |
| A stock OUT that takes a consumable below its minimum | `low_stock` | every admin |
| Approving or denying an access request | `access_request.decided` | the requester (a `.test` address) |
| Later, by the expiry sweeper: warranties ending within 90 days, grants expiring within 14 days | `warranty_expiring`, `access_grant_expiring` | every admin |

A full run raises well over a thousand of these. User creation, temporary passwords, access-request
creation and everything else in the run send no email. Mock addresses use the reserved `.test` TLD
(`firstname.lastname@acme-demo.test`), which never resolves, so nothing reaches a real mailbox
except your own admins'.

## What it creates

| Area | What, and the variations covered |
| --- | --- |
| Taxonomies | Extra asset, application and consumable categories; three seeded categories renamed; a CPU/RAM/OS specs dictionary on *Laptop* |
| Locations | Three sites → buildings → floors → rooms, a datacenter with racks, IT storage cages, a colocation, *Remote workers* and an off-site repair vendor: every location type |
| Asset models | Laptops to firewalls with default specs; two legacy models archived |
| Status labels | Custom labels mapped onto every built-in status |
| Suppliers | With contacts and tax IDs; two archived |
| Tag scheme | Enabled with an `ACME-` prefix if the instance has none, so new assets get tags |
| Applications | A SaaS / internal catalog with categories, three critical, seats, costs and renewals |
| Users | Mostly VIEWER, about a sixth MEMBER, a handful of ADMIN; legajo and username (some left empty); a manager hierarchy plus some free-text external managers; some deactivated, some offboarded through the real offboarding endpoint, a few with a pending temporary password |
| Assets | Every built-in status and every custom label; serials, tags, specs, costs, warranties (some expired, some expiring soon); about 60% checked out, some with several owners, some with a check-out → check-in → check-out history; some archived |
| Access grants | Varied access levels, backdated; some with a future expiry, some already expired, some expiring within two weeks, some revoked; offboarding revokes more |
| Access requests | Pending, approved (creating the grant) and denied with a reason, from several requesters |
| Consumables | IN / OUT / ADJUSTMENT history, deliveries to users, assets and locations, returns of returnable items, some below their minimum and some out of stock; one archived |
| Purchases | Draft, ordered, cancelled and archived; receipt states none, partial, received and over-received; cancelled remaining units; applied license seats; asset, consumable, license and service lines, so pending units exist |
| Knowledge base | A folder tree four levels deep with restricted folders (by role and by application grant); articles in Markdown (headings, lists, code blocks, tables), published and draft, some unpublished again, some revised, some linked to assets and applications, some with `[[wiki-links]]` |

Out of scope on purpose: infrastructure nodes and reporting agents, access workflows and connections
(they could call external systems), AI settings and directory sync.

## Counts

`--profile full` (the default) aims at about 4,000 users, 2,000 assets, 5,000 access grants,
30 requesters, 80 purchases and 700 articles. `--profile small` is about 5% of that, for a quick
check. The catalogs (applications, suppliers, labels, models, consumables, folders, locations) are
the same in both profiles: they are cheap and they carry the variations.

No target is round. Every count is moved 4-15% off its nominal value (a few units for the small
catalogs) and never lands on a multiple of ten, so a full run creates something like 3,809 users and
1,881 assets. The offset comes from `--seed`, so the same seed always resolves the same targets; the
preflight prints them. `--count users=500` sets one volume exactly instead.

## Re-running and resuming

Every top-level record has a natural key derived from the seed: email for users, serial for assets,
name for catalogs, SKU for consumables, reference (`PO-ZS-0001`…, the letters derive from the seed)
for purchases, slug for articles,
the user + application + level for a grant, the requester for access requests. A run first reads what
exists and creates only what is missing, so a second run with the same seed and profile creates
nothing. An interrupted run (a crash, Ctrl-C) is resumed by running the same command again.

Steps that hang off a record — an asset's assignments, a grant's revocation, a purchase's receipts,
a consumable's movements, an article's links — run only when their parent is new or still has none
of them, so a parent that was interrupted half-way through its steps is not completed later. A full
run on top of a small one with the same seed adds to it: record *N* is identical in both profiles.

## How requests are filed

`POST /access-requests` always files for the caller, and there is no admin endpoint to file on
someone's behalf. For each requester the script resets the password with the admin
*temporary password* delivery, signs in as that user, changes the password to a random one that is
never stored or printed, files the requests, and signs out. The admin then approves or denies. The
login limiter allows ten sign-ins a minute per IP, so this phase waits it out: about three minutes on
a full run.

## Flags

| Flag | Meaning |
| --- | --- |
| `--profile full\|small` | Volume profile. Default `full`. |
| `--seed <text>` | Seed for every generated value and every target count. Default `lazyit-demo`. |
| `--count <key>=<n>` | Exact target for one volume (`users`, `assets`, `grants`, `requesters`, `purchases`, `articles`). Repeatable. |
| `--concurrency <n>` | Parallel requests, 1-64. Default 8. Requests that get 429 or 502-504 are retried with backoff. |
| `--allow-email` | Run even though SMTP is enabled. |
| `--yes`, `-y` | Skip the typed confirmation. |
| `--inventory` | Print the read-only inventory and exit; writes nothing. |
| `--help`, `-h` | Print the flags and environment variables. |

Each phase prints its progress and its created / skipped / failed counts. The run ends with a summary
per entity, the failures grouped by message, and an inventory read back from the API (users by role
and state, assets by status and label, grants, requests by status, purchases by status and receipt,
consumables below their minimum, articles by status per folder depth). A failed row is reported and
the run goes on; a phase where every row fails stops the run. The exit code is 0 when every row
succeeded, 2 when some failed and 1 when the run stopped.

## Limits

- User departments and job titles are not settable: `POST /users` does not accept them (only the
  directory import carries them).
- Check-out acknowledgements are not generated: only the assignee can acknowledge.
- Dates are relative to the day of the run, so "expiring soon" stays meaningful; everything else is
  fixed by the seed.

## Developing it

The script lives in `scripts/demo-data/` with its own `tsconfig.json`. It types every request and
response with `@lazyit/shared`, so an API contract change surfaces as a type error:

```bash
bun run --filter @lazyit/shared build
bunx tsc --noEmit -p scripts/demo-data/tsconfig.json
```

To try it locally, bring the stack up per [[setup]], create the first admin at `/setup`, and point
`LAZYIT_URL` at `http://localhost:3001`.
