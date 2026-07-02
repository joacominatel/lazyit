---
title: Releasing lazyit
tags: [runbook, release, versioning, deploy]
updated: 2026-07-02
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
3. Merge the promotion. The `release` job creates the **annotated, signed tag** + a **GitHub
   Release** with generated notes. CI is otherwise push-free — there is **no external cron or
   tagging script**; the Action is the automation.
4. **Rebuild the production images on the host** (`docker compose ... up -d --build`). The
   version an instance reports comes from the tag: `git describe --tags` → build-arg
   `APP_VERSION`/`GIT_SHA` (baked by `infra/start.sh`/compose) → `GET /instance/version` →
   **Settings → Instance**.

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
**verified dual `pg_dump`** first, `git verify-tag`s the target, fails loud on a missing env var
(**never writes `.env.prod`**), builds before swapping, health-gates, and — on failure —
auto-rolls-back only when no migration ran, otherwise stops with a confirm-gated, human-run
restore. In-app, an ADMIN only **enqueues an `UpdateRun` and sees the command to run**; the API
never executes the update.

See also: [[deploy-self-hosted]], [[backups]].
