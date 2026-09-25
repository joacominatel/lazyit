---
title: Security summary / dashboard
tags: [security, dashboard]
status: draft
created: 2026-05-25
updated: 2026-09-25
---

# Security summary

Snapshot of the security review. Updated each sweep. Method:
`.claude/skills/lazyit-sentinel/SKILL.md`. How to read: [[06-security/_MOC|Security MOC]].

## Sweeps so far

1. **2026-05-25 — initial backend baseline.** All committed modules at the time (users, locations,
   asset-categories, asset-models, assets, asset-assignments, article-categories, articles) +
   transversal (CORS, exception filter, shim, soft-delete, jsonb, infra). → SEC-001..SEC-007.
2. **2026-05-25 — Access pillar pass.** `applications`, `application-categories`, `access-grants`
   (+ nested `/users/:id/access-grants`, `/applications/:id/access-grants`), schema/migration and
   ADR-0023. → SEC-008; broadened SEC-004 (uuid path params) and SEC-007 (three more list endpoints).
3. **2026-05-26 — Post-sweep remediation.** SEC-001, SEC-004, SEC-005, SEC-006, SEC-008 were
   fixed by the remediator and moved to `docs/06-security/closed/`. Remaining open: SEC-002,
   SEC-003, SEC-007.
4. **2026-06-02 — Trust-boundary hardening (born-closed).** [[SEC-009-swagger-docs-public-anonymous-surface\|SEC-009]]
   (Swagger no longer public — `NODE_ENV` gate + Caddy) and
   [[SEC-010-setup-rate-limit-xff-spoof\|SEC-010]] (setup rate-limit + audit key on the verified
   `req.ip` via Caddy `trusted_proxies` + Express `trust proxy`) were filed **and** fixed in one PR;
   both went straight to `closed/`. DEF-003 (public Swagger) resolved by SEC-009.
5. **2026-06-03 — AuthZ epic (Roles & Permissions v2 + Service Accounts).** Not a sweep but a posture
   change: authorization moved to a **single DB-first `@RequirePermission` primitive** (the legacy
   `@Roles` retired), and the **read-authz gap closed** — `accessGrant:read` + `user:read` are
   pre-tightened to ADMIN + MEMBER, so a VIEWER can no longer enumerate the access map / user directory
   ([[0046-roles-permissions-v2]]). A second **service-account** principal (fail-closed, lazyit-native
   token, never ADMIN) landed with its own invariants ([[0048-service-accounts]]). The non-negotiables
   are [[INVARIANTS]] (INV-8 + INV-SA-1…4). This **resolves the DEF-001 residual** (the long-standing
   "reads open to any authenticated user").

6. **2026-06-06 — Full-backend parallel sweep (7 domain agents).** A coordinated CTO-led sweep split
   the whole `apps/api` backend across 7 blue-team agents, each owning 2-4 domains **and their
   cross-service integration**: auth+identity/config/service-accounts, users/user-history/access-grants,
   assets/asset-assignments/asset-history, asset-categories/asset-models/locations,
   applications/consumables (+ categories + movements), articles/article-categories/search, and the
   transversal/infra surface (common pipe, prisma, logging, dashboard, health, main, compose/caddy).
   → SEC-011, SEC-012, SEC-020..022, SEC-030..032, SEC-040..041, SEC-050..052, SEC-060..061,
   SEC-070..071 (17 new). No Critical. One **High** (SEC-020, JIT email-link account-takeover under
   BYOI — **now closed**). Per-agent sweep reports: `sweep-2026-06-06-*.md`. Re-verified SEC-004/005/008/009/010
   (closed) did not regress — **except SEC-051 re-opens the SEC-008 class** via a new bypass vector.
   SEC-011, SEC-020, SEC-031, SEC-061 subsequently fixed and moved to `closed/`.

7. **2026-06-20 — KB access hardening + directory-person invariants + #555 SA-ungrantable fast-follow.**
   Reviewing the KB access path + the import's directory-person model added the
   [[INVARIANTS]] INV-DIR-1/2 directory-person invariants and filed
   [[SEC-072-asset-specs-schema-global-bound-and-deep-equal-guard\|SEC-072]] (the global structural
   bound on `AssetSpecsSchema` + the `jsonDeepEqual` depth guard, extending SEC-032 and now
   import-reachable; **closed 2026-09-23** with SEC-032 by #1321 — a structural write bound on
   `specs` in the shared schema plus an iterative `jsonDeepEqual`). The #555 fast-follow made `secret:*` / `import:run` **SA-ungrantable**
   (added to `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`), **reserved the engine service-account
   name**, and **generalised the parity test** so the ungrantable set stays enforced.

8. **2026-09-24 — AI assistant pre-merge review (epic #1315).** Two findings, both found while checking
   the AI tool PRs against the current `dev` code:
   [[SEC-073-sa-ungrantable-permissions-not-stripped-at-principal-load\|SEC-073]] (**Medium**): a
   service account granted `user:manage`/`settings:manage` before the SEC-011 fix still holds that
   permission, because the principal loader filters grants by catalog only and `UsersController` has no
   Layer-2 guard. Such an account can still mint an ADMIN over HTTP, and headless via `user_create` once
   #1343 lands. **Closed 2026-09-24**: the principal loader now strips the SA-ungrantable set, so a
   legacy grant is inert on every route and channel.
   [[SEC-074-kb-loadowned-403-vs-404-existence-leak\|SEC-074]] (**Low**): KB write paths return 403 to a
   non-author for a folder-hidden PUBLISHED article, which confirms it exists (INV-9). The KB AI write
   tools (#1342) will expose the same response. **Closed 2026-09-24**: `loadOwned` and `restore` run the
   folder ACL before the authorship 403, so a folder-hidden article is a 404 on every write path.

9. **2026-09-24 — Workflow-engine route gaps from the AI authoring review (epic #1315, PR #1354).**
   Four findings on the workflow routes, found while reviewing the AI authoring tools. The AI tools
   already guard them; the HTTP routes do not. Verified against `origin/dev` 62aa1e53.
   [[SEC-075-connection-default-headers-credential-unprotected\|SEC-075]] (**Medium**): connection
   `defaultHeaders` can hold a pasted token. `GET /workflow-connections[/:id]` (`workflow:read`, which
   service accounts can be granted) returns the values, and a `workflow:manage`-only principal can
   re-point the host so the header goes to it, because CSEC-1 only covers `secretId`.
   [[SEC-076-connection-url-userinfo-credential\|SEC-076]] (**Low**): `publicHttpsUrl` accepts
   `https://user:pass@host`, which Node sends as `Authorization: Basic`, a credential kept in plain config.
   [[SEC-077-workflow-enable-version-race\|SEC-077]] (**Low**): enable and version authoring take no
   expected version, so a version authored after a review goes live unseen.
   [[SEC-078-dry-run-offboarded-sample-grantee\|SEC-078]] (**Low**): the dry-run renders an offboarded
   sample grantee's details (nested include without a soft-delete filter, the SEC-040 class).
   SEC-074 was not affected by this change (closed separately). **All four ✅ closed the same day** (epic
   #1315): header values and URL userinfo redacted on read and gated under `workflow:secrets`,
   userinfo refused on write (legacy rows keep running, flagged), `expectedVersion` / `baseVersion` 409 preconditions, and
   the dry-run refuses offboarded or revoked samples.

10. **2026-09-24 — Auth.js dependency advisories (#1399).** `bun audit` flagged `next-auth@5.0.0-beta.31`
   for four advisories (GHSA-8fpg, GHSA-7rqj, GHSA-xmf8, GHSA-x445). Only GHSA-8fpg applies:
   [[SEC-079-next-auth-advisories-config-error-fail-open\|SEC-079]] (**Low**). A server config error made
   the web's `!session` guards fail open. This affected only the UI shell, because the API still
   authorizes on its own Bearer. **✅ Closed the same day**: upgraded to beta.32, and every server-side
   guard now requires `session.user` through `hasSession()`.

11. **2026-09-25 — AI assistant, MCP and OAuth integrated review (epic #1315, W4-2).** Gates G1–G4
   re-run over the integrated feature on `origin/dev` 8012f468, plus a sweep of `apps/api/src/{ai,oauth,mcp}`
   and the web surfaces that render model or untrusted content → [[sweep-2026-09-25-ai-assistant]]. G1 and
   G4 pass; G2 and G3 pass with findings. Four new findings:
   [[SEC-080-untrusted-source-provenance-inert-for-real-read-tools\|SEC-080]] (**Medium**): the chat's
   untrusted-source marker is keyed on `entityRefs`, which real read tools never return. A write
   proposed in the same turn after reading a KB article, a search hit or an asset note therefore shows
   no banner and is auto-approved. The documents say this case is closed.
   [[SEC-081-sa-mutation-cap-counts-batch-as-one\|SEC-081]] (**Low**): the per-SA AI mutation cap
   counts calls, so a 200-row batch counts as one change.
   [[SEC-082-oauth-consent-admin-step-up-no-backoff\|SEC-082]] (**Low**): the `lazyit.admin` consent
   step-up has only a 10-per-minute window, no per-account backoff, and no audit of failures.
   [[SEC-083-mcp-query-token-scan-unbounded-before-gates\|SEC-083]] (**Low**): the `/mcp` query-token
   revocation runs one DB lookup per value, unbounded, before the MCP-off 404 and the IP limiter.

12. **2026-09-25 — Mermaid 12 upgrade follow-up (#1429, born closed).**
   [[SEC-084-mermaid-html-labels-remote-image-load\|SEC-084]] (**Low**): `flowchart.htmlLabels: false`
   is deprecated and no longer stops flowchart node labels rendering as HTML, so a KB author's `<img>`
   in a node label loaded a remote image for every reader (a tracking pixel; strict mode still stripped
   script). **✅ Closed the same day**: the root `htmlLabels: false`, listed in `secure` so a diagram's
   directive or front matter cannot re-enable it.

Frontend (`apps/web`) and dependency auditing remain **out of scope** for the general sweeps. SEC-079 is a
one-off dependency triage, SEC-084 a one-off web finding from a dependency upgrade, and sweep 11
covered only the AI web surfaces (chat renderer, approval cards,
consent page, `/account/ai`).

## Counts by severity (open)

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 12 |
| Info | 0 |
| **Total open** | **13** |

Deferred (accepted ADR debt, not findings): **3** active (DEF-001 ✅ — incl. its read-authz **residual**,
now closed by [[0046-roles-permissions-v2]] — and DEF-003 ✅ resolved) — see [[deferred]].

## Open findings

| ID | Sev | Module | Title |
| --- | --- | --- | --- |
| [[SEC-003-markdown-sanitizer-bypass-asymmetric\|SEC-003]] | 🟡 Low | articles | Bypassable, asymmetric markdown sanitizer (latent stored XSS) |
| [[SEC-007-no-pagination-list-endpoints\|SEC-007]] | 🟡 Low | transversal | List endpoints have no pagination (unbounded responses) |
| [[SEC-012-oidc-audience-not-validated\|SEC-012]] | 🟡 Low | auth | OIDC token audience unvalidated when `OIDC_CLIENT_ID` unset (audience confusion under BYOI) |
| [[SEC-022-isactive-not-rolled-back-on-idp-revert\|SEC-022]] | 🟡 Low | users | `isActive` not reverted on a Zitadel write-back 503 (bounded INV-5 divergence) |
| [[SEC-030-asset-unguarded-soft-deleted-model-location-fk\|SEC-030]] | 🟡 Low | assets | Asset create/update accept a soft-deleted `modelId`/`locationId` (no live-parent guard) |
| [[SEC-040-soft-deleted-parent-leaks-via-asset-includes\|SEC-040]] | 🟡 Low | transversal | Soft-deleted model/location/category leaks via nested asset includes |
| [[SEC-041-soft-delete-no-child-reconciliation-dangling-fk\|SEC-041]] | 🟡 Low | transversal | Soft-delete doesn't reconcile children (dangling FK to invisible parent; `SetNull` only on hard-delete) |
| [[SEC-052-catalog-attach-to-soft-deleted-category\|SEC-052]] | 🟡 Low | applications | App/consumable create/update attach to a soft-deleted `categoryId` (no `assertCategoryUsable`) |
| [[SEC-060-article-restore-skips-category-usable-guard\|SEC-060]] | 🟡 Low | articles | `restore()` skips `assertCategoryUsable` → live article on a soft-deleted category |
| [[SEC-070-health-ready-db-error-leak\|SEC-070]] | 🟡 Low | health | `GET /health/ready` leaks raw pg driver error (internal host/IP/port) to anonymous callers |
| [[SEC-071-dashboard-soft-delete-relation-bypass\|SEC-071]] | 🟡 Low | dashboard | Dashboard aggregates count soft-deleted apps/assets via nested relations (same class as SEC-040) |
| [[SEC-080-untrusted-source-provenance-inert-for-real-read-tools\|SEC-080]] | 🟠 Medium | ai (runtime) | Untrusted-source tracking never fires for real read tools: no banner, and same-turn writes auto-approved |
| [[SEC-081-sa-mutation-cap-counts-batch-as-one\|SEC-081]] | 🟡 Low | ai (headless / mcp) | Per-SA AI mutation cap counts a 200-row batch as one change |

## Top findings

0. **SEC-080 🟠 Open (Medium): fix before ADR-0097 is accepted.** The auto-approve eligibility rule
   (INV-AI-3 as amended) and the CEO's #1409 decision to include untrusted-source proposals in "Approve
   all" both depend on the untrusted-source banner. Today the banner appears only for web search and
   the three `workflow_*_get` reads. Fix: derive the marker from the `<untrusted_content>` tag alone, and
   add a test that uses a real read tool.
0. **SEC-082 / SEC-083 ✅ Closed.** Moved to `closed/` (fixed 2026-09-25, #1315): the consent's
   `lazyit.admin` password goes through the shared `PasswordStepUpVerifier`, so the chat approvals and
   the consent share one per-account backoff, and each refused attempt is audited
   `CONSENT_STEP_UP_FAILED`. The `/mcp` query-token scan is charged to the per-IP limiter first and reads
   at most 4 well-formed values in one query. No data change.
0. **SEC-084 ✅ Closed.** Born closed (fixed 2026-09-25, after #1429): mermaid is initialised with the
   root `htmlLabels: false`, and `htmlLabels` is a `secure` key, so every diagram label is SVG text and
   a KB author can no longer load a remote image in a reader's browser. No data change; HTML tags in
   existing labels now show as literal text.
0. **SEC-079 ✅ Closed.** Born closed (fixed 2026-09-24, #1399): `next-auth` upgraded to beta.32, and the
   web session guards now require `session.user` rather than a truthy `auth()` result. No data change.
0. **SEC-075 / SEC-076 / SEC-077 / SEC-078 ✅ Closed.** Moved to `closed/` (fixed 2026-09-24, #1315):
   connection `defaultHeaders` values and legacy URL userinfo are redacted on every read and a
   `[redacted]` PATCH value keeps the stored one; changing a header value or re-pointing a connection
   that carries headers needs `workflow:secrets` (CSEC-1); userinfo is refused on write while legacy
   rows keep running and are flagged `legacyUserinfo` for a UI warning; enable / version authoring take optional `expectedVersion` /
   `baseVersion` checked under a row lock (409); the dry-run refuses an offboarded grantee or a
   revoked grant. Stored rows are untouched.
0. **SEC-074 ✅ Closed.** Moved to `closed/` (fixed 2026-09-24): the KB write paths (`loadOwned`, and
   the soft-delete `restore`) check the folder ACL before the authorship 403, so a published article in
   a folder the caller cannot read is a 404, the same as a missing id (INV-9). No data change.
0. **SEC-073 ✅ Closed.** Moved to `closed/` (fixed 2026-09-24): `resolveServiceAccountPermissions`
   strips the SA-ungrantable set when the principal is built, so a `user:manage` / `settings:manage`
   grant written before SEC-011 is inert over HTTP, MCP and headless AI. Legacy rows are kept (no
   migration) and removed on the next admin save of the grant set.
1. **SEC-020 ✅ Closed.** Moved to `closed/` (fixed: JIT email-link now checks `email_verified`).
2. **SEC-051 ✅ Closed.** Moved to `closed/` (fixed 2026-09-23, #1320): the `host:port` carve-out in
   `isSafeApplicationUrl` no longer reads a browser-interpreted scheme (`javascript`, `vbscript`,
   `data`, `file`, …) as a host, and the check also runs on the character-reference / percent-decoded
   value. Re-closes the SEC-008 class on create and update.
3. **SEC-011 ✅ Closed.** Moved to `closed/` (SA coarse-permission escalation fixed).
4. **SEC-031 ✅ Closed.** Moved to `closed/` (assignment release TOCTOU fixed).
5. **SEC-021 ✅ Closed.** Moved to `closed/` (deactivating the last active ADMIN now 409s, and the
   last-admin guard counts only active admins; the directory sync skips the last active ADMIN instead
   of offboarding them).
6. **Systemic soft-delete / nested-relation class (SEC-030/040/041/052/060/071; SEC-050 ✅ closed).**
   A recurring pattern across six modules: top-level soft-delete filtering (ADR-0032) doesn't reach
   nested relations, FK guards don't check for a *live* parent, and `SetNull` only fires on
   hard-delete. One architectural fix (filter nested includes + a shared live-parent guard + register
   all soft-deletable models) closes most of them. SEC-050 is now closed: its category half by #325
   (`ConsumableCategory` registered) and its consumable half by guarding the explicit
   `findOne`/`assertExists`/movement paths (the model deliberately stays out of the set for its
   archived-view slice).
7. **SEC-002 — `.docx` decompression bomb.** ✅ Closed 2026-06-07 by ADR-0053's sandboxed worker
   (PR #251, on `feat/issue-247-async-workers-bullmq-valkey`): the parse runs in a heap-capped forked
   child, so a bomb OOMs the child, not the API. Moved to `closed/`; closes on promotion to `dev`.

## Posture context (not a finding — see [[deferred]])

lazyit **authenticates** every request (global `JwtAuthGuard`, OIDC JWT or `X-User-Id` shim, plus a
**service-account** `lzit_sa_…` token branch — [[0038-jit-user-provisioning]], [[0048-service-accounts]])
and **authorizes** it with a single DB-first **`@RequirePermission`** primitive ([[0046-roles-permissions-v2]];
the legacy coarse `@Roles` gate is retired). Permissions resolve from DB rows (the [[role-permission]]
matrix for humans, direct grants for service accounts), never a token claim ([[INVARIANTS]] INV-8/INV-SA-1).
Writes stay ADMIN-only by seed (`accessGrant:grant`, `user:manage`, `:delete`); **the read map is now
tightened** — `accessGrant:read` + `user:read` are ADMIN + MEMBER only, so a VIEWER can no longer
enumerate the access map ([[0023-access-management-design]]) or the user directory. This **closes the May
review's #1 finding AND the read-authz residual** (the old DEF-001 baseline). Service accounts are
**fail-closed** (they 403 on unannotated routes — INV-SA-2) and never ADMIN-equivalent. **Residual
baseline:** the forgeable, dev-only `X-User-Id` shim ([[0022-draft-visibility-auth-shim]]) remains; the
OpenAPI docs are no longer public ([[SEC-009-swagger-docs-public-anonymous-surface\|SEC-009]]: prod
doesn't serve them, Caddy doesn't proxy `/api/docs*`; reachable only internally/in dev). **Aggregate
risk:** much reduced now that mutations are gated and the worst reads tightened, but the operational
guardrail still holds: **do not expose `:3001` (or `:5432`) beyond localhost/trusted dev**, and never run
production with `AUTH_MODE=shim`.

## Coverage & gaps (self-assessment)

- **Covered well:** all backend modules end-to-end (incl. the Access pillar), the `X-User-Id` shim authZ
  rules (vs ADR-0022/0023), the import pipeline, the exception filter, CORS, soft-delete consistency, the
  assignment/grant lifecycle (create live-checks, revoke 409), infra/env, and the cheap
  injection/exec/fs/logging invariants.
- **Access pillar — checked, matched its ADR:** create-time live-check of `userId`+`applicationId`
  (400), actor from a *validated* `X-User-Id` shim (better than AssetAssignment's body actor — see
  [[deferred]] DEF-005), double-revoke 409, no uniqueness (multi-grant by design), `strictObject`
  payloads. No divergence from ADR-0023.
- **Lighter / worth a second pass:** the `nestjs-zod` global pipe boundary (exactly which params are
  validated vs pass-through) was reasoned, not exercised; `mammoth` internals (XML entity handling)
  were not deep-audited (Phase-3 deps); no dynamic testing (API not run).
- **Out of scope:** frontend (`apps/web`, the render sink for SEC-003), dependency CVEs,
  deploy infra (covered by lazyit-devops; SEC-005 now closed).

Related: [[deferred]] · [[INVARIANTS]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[06-security/_MOC|Security MOC]]
