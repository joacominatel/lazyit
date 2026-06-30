---
title: Development — MOC
tags: [moc, development]
status: draft
created: 2026-05-25
updated: 2026-06-16
---

# Development — Map of Content

Everything a developer needs to work on lazyit.

- [[claude-workflow]] — **how we develop** (context-first, ask-don't-assume, subagents,
  commits, docs-sync). The default operating procedure for every change.
- [[setup]] — get the repo running locally (Bun, Docker, Prisma).
- [[workflows]] — day-to-day: dev servers, migrations, building, linting.
- [[code-conventions]] — language, structure, testing, and the Bun-first boundary.
- [[i18n]] — **how to translate a section** (next-intl, cookie-mode, en + es). The operating
  manual for the per-section translation fan-out. Decision: [[0051-i18n-next-intl]].
- [[manual-authoring]] — **how to add a Help / Manual page** (public product docs: frontmatter
  schema, path convention, IA sections, en/es parity + fallback). Decision: [[0062-in-app-help-manual-surface]].
- [[secret-manager-crypto-design]] — **build-time crypto primitives for the Secret Manager**
  (Argon2id KDF, X25519 envelope, AES-256-GCM, recovery key). Pins libraries/parameters before
  any code. Decision of record: [[0061-secret-manager-zero-knowledge]].
- [[ssr-prefetch-recipe]] — **how to server-prefetch a route's first paint** (the thin Server
  Component + `prefetchQuery` + `dehydrate` + `<HydrationBoundary>` mold). The operating manual for
  copying the pattern onto a new route. Decision: [[0067-server-prefetch-ssr-strategy]].

- [[ledger-design-language]] — **The Ledger design language reference** for the `apps/web`
  frontend refactor: concrete OKLCH palette (paper/carbon + oxblood + verify), the type trio
  (Hanken / Commit Mono / Redaction), the shadcn from→to token map, ledger-native patterns, and the
  brand→product register translation. Decision: [[0077-ledger-design-language-frontend-refactor]]
  (#863, branch `refac/frontend-design`).

Domain/data conventions live separately in [[conventions]] (under
[[02-domain/_MOC|Domain]]).
