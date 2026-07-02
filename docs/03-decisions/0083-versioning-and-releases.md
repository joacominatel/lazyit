---
title: "ADR-0083: Tag-driven semver versioning & release automation"
tags: [adr, infra, releases, versioning, ci]
status: accepted
created: 2026-07-01
updated: 2026-07-02
deciders: [Joaquín Minatel]
---

# ADR-0083: Tag-driven semver versioning & release automation

## Status

accepted — issue #903. Establishes the version *identity* half only: how a lazyit build knows
and displays its own version, and how releases are cut. The consumption half — the in-app
"latest known / N versions behind" check, the update notifier and any guided updater — is
deferred to [[0084-update-awareness-and-guided-update]] (future). Builds on [[0025-containerization-strategy]]
(images built on the host from the git checkout) and [[0027-ci-pipeline]] (CD deferred, GHCR
reserved, CI stays `push: false`). Release mechanics ride the existing dev→master promotion flow
([[git-workflow]]).

## Context

lazyit ships zero version identity today (all verified): **zero git tags, zero GitHub Releases**,
placeholder `package.json` versions (root `0.1.0`, api `0.0.1`, web `0.0.0`, unused and
inconsistent), and no version shown anywhere in-app. CI builds the api/web/migrate images with
`push: false` — there is **no registry**; every image is built on the operator's host from the
git checkout. This is greenfield: nothing to migrate away from, so we pick the smallest
convention that fits how lazyit already ships.

The CEO's intent (paraphrased): a version system driven by **tags**, starting at **1.0.0**,
that runs **automatically**, and where "a tiny fix shouldn't be forced into a big visible bump."

Three repo facts shape every choice:

- **`master` = production, reached only by the CEO's dev→master promotion PR** ([[git-workflow]]).
  That merge is already a deliberate, human-gated, batched event every few days.
- **The version unit is the git checkout, not an image.** `compose.yaml`, the prod override, the
  Caddyfile and the Prisma migrations all live in the tree and evolve between versions. There is
  no image tag to be the "version"; the tag on `master` is.
- **Commit prefixes** (`feat`/`fix`/`chore`/`del`/`updt`/`docs`) are **not** Conventional Commits —
  no `BREAKING CHANGE` footer, no scopes. They can *suggest* a bump but cannot *decide* a major.

We deliberately do **not** adopt semantic-release / a full conventional-commits migration: that is
enterprise machinery for a repo where one person merges to `master` every few days.

## Decision

### Release boundary — one promotion, one release

**The dev→master promotion PR is the release boundary.** One promotion = one release. This is the
answer to "a tiny fix shouldn't force a visible bump": small fixes simply **batch into the next
promotion** and ride out as part of its PATCH. If a tiny fix is genuinely the only change in a
promotion, it ships as an honest PATCH (`1.4.2 → 1.4.3`) — low-noise and correct. An **urgent
hotfix is a fast-tracked promotion PR** through `dev`; there is no separate hotfix→master pipeline
and no version-branch bookkeeping.

**v1.0.0 is seeded once, by hand** — `git tag -a v1.0.0` (SSH-signed, see below) on the current
`master` — after which automation takes over.

### Bump policy — suggested by prefixes, overridable by label, never auto-major

On a PR with **base = `master`**, a GitHub Action (`release.yml`) computes a bump **suggestion**
from the commit prefixes since the last tag and comments it on the PR:

| Prefixes present since last tag | Suggested bump |
| --- | --- |
| any `feat` / `updt` / `del` | **minor** |
| only `fix` / `chore` / `docs` | **patch** |
| — (never auto-detected) | **major** |

The CEO may **override** the suggestion with a `release:major`, `release:minor` or `release:patch`
label on the promotion PR. On merge, `release.yml` reads **label-or-suggestion**, computes the next
`vX.Y.Z` from the last tag, and creates the **annotated, signed tag + GitHub Release**. Absent a
label, the suggestion stands.

**MAJOR is never auto-detected.** Prefixes carry no breaking signal, so a major is always a human
decision expressed by the label.

### What MAJOR means — operator impact, not code internals

For a self-hosted end-user app, MAJOR is defined by **operator impact**, not API surface:

- **PATCH** — fixes only; one-click-safe.
- **MINOR** — new features/behaviour, including **auto-running forward migrations**; one-click-safe.
- **MAJOR** — bump only when the update **requires a manual operator step**: a new *required*
  `.env.prod` variable, a manual `compose`/topology change, a migration with manual pre/post steps,
  or a change to a DR linchpin (`ZITADEL_MASTERKEY` / `WORKFLOW_SECRET_KEY` / DB password) — **or**
  when the update is **not cleanly reversible**.

This makes the version number itself the **machine-readable "is this one-click-safe?" contract**
that the future updater ([[0084-update-awareness-and-guided-update]]) keys off — no separate breaking-flag manifest
is needed. "Target is N majors ahead" ⇒ the updater blocks one-click and forces reading the notes.

### Version source of truth — the git tag, injected at build

The **git tag is the single source of truth**, injected at build time — there is **no committed
`VERSION` file** (a committed file would drift, because `master` leads `dev` and agents branch from
`dev`). The images build on the host from a checkout whose context includes `.git`, so:

```
APP_VERSION = git describe --tags --always   # e.g. v1.4.2  or  v1.4.2-3-gabc1234 off-tag
GIT_SHA     = git rev-parse --short HEAD
```

are passed as `--build-arg APP_VERSION` / `--build-arg GIT_SHA` into the api and web Dockerfiles,
baked to `ENV`, and surfaced by a new **`GET /instance/version`** returning `{ current, gitSha }`.
Settings → Instance displays it. Off-tag builds (a rebuild that isn't exactly on a tag) honestly
show the `git describe` form `v1.4.2-3-gabc1234` rather than lying about being a clean release.

> This ADR defines **only the identity half** (`current` + `gitSha`). The "latest known" version,
> the "N behind" comparison and any network check belong to [[0084-update-awareness-and-guided-update]].

### Signed tags — SSH, verifiable, no registry machinery

Tags are **SSH-signed** (`git tag -s`) from v1.0.0 onward; consumers can `git verify-tag`. Because
lazyit updates ride a git checkout (not a registry pull), SSH-signed git tags are the proportionate
integrity control — near-zero cost, no key infrastructure. **Cosign / registry signing is rejected**
(there is no registry to sign into — that would be machinery buying nothing here).

**Implementation note (issue #905):** the signing key belongs to the release owner and never enters
CI, so signing applies to **operator-cut tags** — the hand-seeded `v1.0.0` and any manually created
tag. The tags `release.yml` cuts automatically on promotion are **annotated but unsigned** (tagger =
the GitHub Actions identity). This is consistent with the paragraph below: the signer *is* the GitHub
identity, and the mandatory control is MFA + branch protection on `master`, which gate exactly the
event that triggers the automated tag.

**Organizational prerequisite (recorded, not built here):** the release identity must have **MFA +
branch protection** on `master`. The real single point of failure in any release system is the
GitHub identity, not the transport; signing raises the bar but the signer *is* that identity, so
MFA + branch protection are the actual mandatory control.

### Changelog — auto-generated GitHub Release notes, no committed file

The changelog is the **auto-generated GitHub Release body**, grouped for **humans** (not by raw
prefix):

- **New & Changed** — `feat` / `updt`
- **Fixes** — `fix`
- **Removed** — `del`
- `chore` / `docs` are **hidden** from the user-facing view.

A fixed **`## ⚠️ Upgrade actions`** section is **REQUIRED whenever the bump is major** — this is
where "requires a manual step" warnings live (new required env var, manual migration step, etc.), so
the future updater can surface them verbatim. Two audiences — the operator (what must I *do* to
upgrade) and the end-user (what *changed* for me) — are served by this one stream.

There is **no committed `CHANGELOG.md`**: it would drift across the two-branch flow (master leads
dev) and add a file-by-file commit to every promotion. The tag + GitHub Release are the record.

### CI stays push-free

CI continues to build all three images with **`push: false`** — **no GHCR publishing in this ADR**.
Images remain host-built from the checkout ([[0025-containerization-strategy]], [[0027-ci-pipeline]]).
Publishing versioned images is recorded as a deferred optimization (below), not part of this change.

## Consequences

- lazyit gains a real, visible, honest version: `GET /instance/version` and Settings → Instance show
  the running tag (or the off-tag `describe` form), baked at build with zero drift risk.
- Releases are cut at the moment that already matters (the promotion), with one CEO click at most
  (a label) and a trustworthy MAJOR signal.
- The version number becomes an **operator-meaningful contract** the future updater can trust —
  MAJOR ⇒ "not one-click-safe" — without any extra manifest.
- Signed tags give a `git verify-tag` integrity anchor and a named, addressable rollback target
  (previously "the previous version" was an unnamed git state).
- **New surface, small:** a `release.yml` workflow, two Dockerfile build-args, and one `GET
  /instance/version` endpoint. No schema change, no new runtime dependency, no registry.
- **Accepted ceilings:**
  - The bump suggestion is a heuristic — a promotion that quietly adds a required `.env.prod` var but
    carries only `fix` commits would be *suggested* as a patch. Guarding against that is exactly why
    MAJOR is a human label, not an algorithm; the promoter is accountable for setting it.
  - Off-tag rebuilds report `vX.Y.Z-n-gsha` — intentionally honest, occasionally noisy.
  - Restricted-egress instances cannot `git verify-tag` against a remote signer they can't reach —
    the verification is best-effort and never blocks running the app (the updater ADR owns egress
    behaviour).

## Considered alternatives

- **Full semantic-release / conventional-commits migration.** Rejected — enterprise machinery for a
  one-person-merges repo; would force a commit-convention change and still couldn't emit a correct
  MAJOR for operator-impact reasons. The suggestion+label model gives the same automation at a
  fraction of the cost.
- **Committed `CHANGELOG.md`.** Rejected — drifts across the master-leads-dev flow and adds a commit
  to every promotion. GitHub Release notes give the same value with zero drift. (Reconsidered only if
  air-gapped operators need it offline — see Deferred.)
- **Per-commit or per-PR-to-dev releases.** Rejected — floods the release feed with docs/chore noise
  and trains operators to ignore it. The promotion is the only boundary that is already deliberate
  and batched.
- **Auto-detected MAJOR from commit volume/prefixes.** Rejected — prefixes carry no breaking signal;
  a single careless `feat` could force a major, and a real breaking change hidden among `fix` commits
  would silently under-version. MAJOR must be a human decision.
- **Monorepo per-package versions.** Rejected — lazyit ships as one stack; there is **one product
  version** for the whole thing, not independent api/web/shared versions.
- **Cosign / registry image signing.** Rejected — no registry exists; SSH-signed git tags match the
  git-checkout update model at near-zero cost.
- **Committed `VERSION` file as source of truth.** Rejected — drifts (master leads dev); the git tag
  injected via build-arg is drift-free.

## Deferred

- **GHCR publishing.** Turning on the reserved [[0027-ci-pipeline]] CD path (versioned images pushed
  on tag) is a future optimization — it would speed patch updates and enable image-swap when
  `compose.yaml` is unchanged, but it adds registry auth and can't handle the common case where
  compose/migrations changed anyway. CI stays `push: false` here.
- **Offline `CHANGELOG.md`.** A generated, committed changelog for egress-restricted/air-gapped
  operators who can't reach GitHub Releases — revisit only if that need is real.
- **The consumption half — [[0084-update-awareness-and-guided-update]]** (future): latest-known-version check,
  "N versions behind" indicator, weekly digest email, and any guided updater. This ADR deliberately
  stops at version *identity*.

## Amendment (2026-07-02) — support & deprecation policy

Two operator-facing contracts implied by the bump policy above, stated explicitly (issues #910, #911).

### Support policy — latest-only

**Only the latest release is supported; operators should stay current.** There is no long-term-support
branch and no backporting to older versions. **Version jumps are safe** — going from, say, `1.2` straight
to `1.9` in one upgrade does **not** require installing the intermediate versions: the one-shot `migrate`
job runs `prisma migrate deploy`, which applies **every pending migration in sequence** ([[prisma-migrations]]).
The **one exception** is a **MAJOR** in the range — a major carries a `## ⚠️ Upgrade actions` section (above)
whose manual step(s) must be performed. So "jump freely across PATCH/MINOR, but stop and read the notes at
each MAJOR you cross." The guided [[0084-update-awareness-and-guided-update|updater]] (`infra/update.sh`)
enforces exactly this: it blocks one-click across a MAJOR and surfaces the Upgrade actions verbatim.

### Deprecation policy — announce in a MINOR, remove in the next MAJOR

Anything **user- or operator-facing** — an endpoint, a config/env var, an import/export format — follows a
two-step retirement:

1. **Deprecated in a MINOR.** The deprecation is announced in that release's changelog
   ("New & Changed" above): *"deprecated, will be removed in X.0"*. The surface keeps working — a MINOR
   stays one-click-safe (see "What MAJOR means" above), so nothing an operator relies on breaks yet.
2. **Removed only in the next MAJOR.** Removal never happens in a PATCH or MINOR. Because a MAJOR already
   means "the operator must read the `## ⚠️ Upgrade actions`" (above), the removal lands where operators are
   already required to read the notes — the removal is listed there, so it never surprises anyone who
   followed the version contract.

This gives every retirement a predictable, pre-announced home and keeps the version number's
"is-this-one-click-safe?" contract honest: a deprecation alone never forces a manual step, but the eventual
removal rides the MAJOR that already carries one.

## Amendment (2026-07-02) — distributed-binary version handshake

Issue #907. lazyit ships two binaries that drift from the server — the reporting agent
([[0074-server-reporting-agent]]) and `lazyit-fetch` ([[0080-service-account-secret-retrieval]]). They
now reuse this ADR's **identity** mechanism so skew is visible. Deliberately **warn/hint-only, never a
gate** (a version negotiation protocol would break running agents and is explicitly out of scope; a
minimum-supported-version gate is future work).

- **Same build stamp.** Both binaries bake `APP_VERSION` at compile time via `bun build --define`
  (`process.env.APP_VERSION` ⇐ `git describe --tags --always`, env-overridable by the release build),
  mirroring the api/web `--build-arg APP_VERSION`. An unstamped/source build reports `"dev"`.
- **Agent → server.** The agent already carries `agentVersion` in its check-in (`POST /infra/report`);
  the server now persists it to a first-class **`InfraNode.agentVersion`** column (migration
  `20260702010000_infra_node_agent_version`, backfilled from the prior `specs.agentVersion`). Topology
  (Servers table + node panel) shows a subtle **"Agent outdated"** badge when the agent is a MAJOR
  behind the server — display-only.
- **`lazyit-fetch` → server.** On each run it best-effort probes `GET /instance/version` with its SA
  token and prints a one-line **stderr** warning when it is a MAJOR behind (never stdout — `.env`
  piping stays clean). No server-side storage or new endpoint; silent on any failure.
- **Skew rule — MAJOR-only.** A shared pure helper `isMajorBehind(client, server)`
  (`@lazyit/shared` `utils/semver.ts`) returns true only when the server's MAJOR exceeds the client's.
  MAJOR is this ADR's "not one-click-safe / must read the notes" boundary, so a MAJOR gap is the only
  meaningful contract-break signal; PATCH/MINOR drift is expected and one-click-safe and is never
  nagged. Either side `dev`/unparseable ⇒ never behind (fail-soft — never nag a dev/pre-stamp build).

## Amendment — security-release flag (issue #908, 2026-07-02)

An OPTIONAL `release:security` label on the promotion PR is orthogonal to the semver `release:*` bump. When
present, the release job writes a stable, machine-parseable marker into the Release notes: a `## 🔒 Security
release` heading followed by the exact HTML comment `<!-- lazyit:security -->` (human-visible heading +
whitespace-free parseable literal — chosen over a fragile title convention). The marker literal is mirrored
in `packages/shared` as `SECURITY_RELEASE_MARKER` (a bash workflow cannot import the shared package — keep
the two in sync). Absent by default: a routine promotion carries no marker. The consumption side is
[[0084-update-awareness-and-guided-update|ADR-0084]] §amendment.
