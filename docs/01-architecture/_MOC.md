---
title: Architecture — MOC
tags: [moc, architecture]
status: draft
created: 2026-05-25
updated: 2026-06-03
---

# Architecture — Map of Content

How lazyit is built and run.

- [[stack]] — languages, frameworks, runtime and versions (verified against the repo).
- [[monorepo]] — workspace layout, package boundaries, how `@lazyit/shared` is shared.
- [[shared-package]] — the contract for what may live in `@lazyit/shared`.
- [[deployment]] — self-hosting target and topology (skeleton — not yet decided).
- [[auth-zitadel-sot]] — Zitadel source-of-truth (Option B) design dossier: IdentityProvider adapter,
  Management-API write-back, zero-touch bootstrap, setup wizard, threat model + implementation roadmap.
  Decision of record: [[03-decisions/0043-zitadel-source-of-truth]].
- [[authorization]] — the **authZ** architecture: the `@RequirePermission` single-guard model,
  DB-first permission resolution, the catalog-as-code, and the two principal kinds (human [[user]] +
  non-human [[service-account]]). Decisions of record: [[03-decisions/0046-roles-permissions-v2]] +
  [[03-decisions/0048-service-accounts]].

Decisions behind these choices live in [[03-decisions/_MOC|Decisions]].
