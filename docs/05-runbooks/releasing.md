---
title: Releasing lazyit
tags: [runbook, release, versioning, deploy]
updated: 2026-10-09
---

# Releasing lazyit

How a version gets cut, published and deployed. Design and rationale live in
[[0083-versioning-and-releases]] (versioning) and [[0084-update-awareness-and-guided-update]]
(the guided host updater). This is the operational how-to.

## The model in one line

**A release = a `dev → master` promotion PR.** One promotion = one version. You tag when you
ship to production, not on a schedule. Between promotions the version does not change.

## The automatic flow (steady state)

Once `v1.0.0` exists on `master`, releases are cut by CI — you do not tag by hand:

1. Open the `dev → master` promotion PR. `.github/workflows/release.yml` posts a **bump
   suggestion** derived from the commit prefixes since the last tag:
   - `feat` · `updt` · `del` ⇒ **minor**
   - only `fix` · `chore` · `docs` ⇒ **patch**
2. Override the bump if needed with a **`release:major|minor|patch`** label on the PR.
   - **MAJOR is never auto-detected** — it means operator impact (a new required env var, a
     manual compose/migration step, a DR-linchpin change). You mark it deliberately, and its
     Release notes must carry a **"⚠️ Upgrade actions"** section.
3. Merge the promotion. The `release` job creates the **annotated tag** (unsigned — CI holds no
   signing key; see *Tag trust* in [[0083-versioning-and-releases]]) + a **GitHub Release** with
   generated notes. CI is otherwise push-free — there is **no external cron or
   tagging script**; the Action is the automation.
4. **Rebuild the production images on the host** (`docker compose ... up -d --build`). The
   version an instance reports comes from the tag: `git describe --tags` → build-arg
   `APP_VERSION`/`GIT_SHA` (baked by `infra/start.sh`/compose) → `GET /instance/version` →
   **Settings → General & version** (`/settings/instance`).

> In `bun dev` the app **always reports `dev`** — there is no baked version in dev mode. A real
> version only appears in a production image build.

## The one-time `v1.0.0` seed (genesis)

`release.yml` **refuses** to auto-create `v1.0.0` (genesis + MAJORs are human calls). Seed it by
hand **on the already-promoted `master`** — master must already contain `release.yml` and the
`/instance/version` endpoint (i.e. promote `dev → master` **first**, then tag; tagging an old
master points the release at code without the versioning system and the auto-flow won't run):

```sh
git checkout master && git pull
git tag -s v1.0.0 -m "lazyit v1.0.0"     # SSH-signed; needs gpg.format=ssh + user.signingkey
git push origin v1.0.0
gh release create v1.0.0 --notes-file <curated-notes.md>
```

- The **tag message** (`-m`) is short — `lazyit v1.0.0`. Omitting `-m` opens `$EDITOR`; if you get
  stuck in Vim, `Esc` then `:q!` aborts.
- The **Release notes** are a separate, curated product summary. Do **not** use
  `--generate-notes` on the first tag — it dumps the entire commit history.
- Signing: `git config --global gpg.format ssh` + `git config --global user.signingkey <key>.pub`.
  If you can't sign yet, `git tag -a` (annotated, unsigned) is acceptable to start; adopt signing
  later. Automation tags are annotated and unsigned by design ([[0083-versioning-and-releases]]).
- **Any tag cut by hand must be annotated (`-a` or `-s`), named `vX.Y.Z`, and on `master`** — the
  guided updater refuses a lightweight tag, any other name, or a commit that is not on `master`.

## Policies

- **Support: latest-only.** Version jumps (e.g. 1.2 → 1.9) are safe because
  `prisma migrate deploy` applies pending migrations in sequence — **unless** a MAJOR's
  "⚠️ Upgrade actions" says otherwise. Stay current; only the latest release is supported.
- **Deprecation: announce in a MINOR, remove in the next MAJOR.** Anything user/operator-facing
  (an endpoint, a config/env var, an import/export format) is deprecated in a MINOR's changelog
  ("removed in X.0", still working) and removed only in the next MAJOR.

## Deploying / updating a running instance

The update unit is a **git checkout + rebuild** (images build on the host; there is no registry —
[[0027-ci-pipeline]]), so an image-swap update is structurally impossible. Operators update with
the guided **`infra/update.sh`** ([[0084-update-awareness-and-guided-update]]): it takes a
**verified `pg_dump`** of the app database first (an install still wired to the removed bundled Zitadel
is refused before that — [[migrate-off-bundled-zitadel]]), checks
the target is a real release (an annotated `vX.Y.Z` tag on `origin/master`, fetched over HTTPS or SSH;
a signature, when present, must not be bad — see *Tag trust* in [[0083-versioning-and-releases]]), fails loud on a missing env var (**never writes
`.env.prod`**), builds before swapping, health-gates, and — on failure — auto-rolls-back only when
no migration ran, otherwise stops with a confirm-gated, human-run restore. In-app, an ADMIN only **enqueues an `UpdateRun` and sees the command to run**; the API
never executes the update.

> [!warning] Updating **from v2.0.0 or earlier** — the update to v2.1.0 is done by hand (#1458)
> Up to v2.0.0, `update.sh` required a tag signature that the automated release tags never carry, so it
> always stopped at its tag check (after the backup, before touching the running stack). The fixed check
> ships in v2.1.0 — but `update.sh` always runs the copy from the version you are **leaving** (it re-runs
> itself from a temporary copy of the current checkout's script), so the fix only helps updates *from*
> v2.1.0. For the step to v2.1.0, back up first ([[backups]]), then:
>
> ```sh
> git fetch --tags && git checkout v2.1.0 && ./infra/start.sh
> ```
>
> `start.sh` detects the existing install, keeps every secret, and rebuilds. From v2.1.0 on,
> `./infra/update.sh vX.Y.Z` works again.

> [!warning] Updating **from v2.1.0** with local or BYOI auth — the next update is done by hand (#1545)
> Through v2.1.0, `update.sh` always dumped the bundled Zitadel's database, which local and BYOI installs do
> not run, so it stops at its backup step before touching anything. Its env check also asked for the
> bundled-only `ZITADEL_*` and OIDC keys those installs leave unset. The fix ships in the first release after
> v2.1.0 and, for the same re-exec reason, only helps updates *from* that release. For that one step, back up
> first ([[backups]]), then run the same `git fetch --tags && git checkout vX.Y.Z && ./infra/start.sh`.
> A bundled-Zitadel install takes neither path — see the next note.

> [!important] The bundled-Zitadel removal ships as a MAJOR (ADR-0102, #1543)
> Removing the bundled Zitadel is operator impact, so its promotion carries the **`release:major`**
> label, and its Release notes open with a **"⚠️ Upgrade actions"** section saying:
>
> - **Local auth** (`AUTH_MODE=local`): nothing to do.
> - **Your own IdP** (BYOI, `AUTH_MODE=oidc`): nothing required — `/setup`, user creation, user edits
>   and offboarding stop returning 503. The API never reads `OIDC_CLIENT_SECRET` or
>   `IDENTITY_PROVIDER_TYPE`; delete them when convenient. Offboarding does not touch your IdP: disable
>   the account there too ([[auth-bootstrap]] §5).
> - **Bundled Zitadel**: `start.sh`, `update.sh` and the API refuse the install with nothing changed.
>   Do not run `update.sh` across this release; follow [[migrate-off-bundled-zitadel]].
> - From **v2.1.0** with local or BYOI auth, the previous note still applies: take this release with
>   `start.sh`.

See also: [[deploy-self-hosted]], [[backups]].
