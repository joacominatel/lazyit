# Documentation accuracy/drift, developer experience, conventions adherence

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Cross-cutting**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** Auth shipped but the README, setup.md, CTO system-map, ADR-0016 and the security docs still describe lazyit as unauthenticated/IdP-undecided — and setup.md no longer produces a working dev environment.

## Findings (11)

### 1. README's top-level 'Auth is deferred / unauthenticated / must not be exposed publicly' is false

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | high | quick-win | high |

- **Location:** `README.md:61-63 (vs apps/api/src/auth/jwt-auth.guard.ts, apps/web/auth.ts, infra/docker-compose.prod.yml)`
- **Why it matters:** The most-read doc and public face of the project tells operators the build has no auth and must be hidden, while code ships a full OIDC stack (global JwtAuthGuard validating Bearer JWTs via JWKS + JIT provisioning; apps/web/auth.ts Auth.js v5 client; Zitadel in prod compose). ADR-0037/0038/0039 accepted; PR #58/#60 merged. AUTH_MODE=shim is only the dev default. A false security posture in the headline doc destroys doc trust and contradicts the 'accurate guidance' mandate.
- **Recommendation:** Replace the blockquote with the current posture: OIDC via bundled Zitadel (BYOI by 3 env vars), AUTH_MODE=shim dev-only, link ADR-0037/0039 + docs/05-runbooks/auth-bootstrap.md. Keep a 'never run prod with AUTH_MODE=shim' warning.

### 2. setup.md no longer yields a working dev environment — omits Meilisearch, Zitadel and the web env entirely

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | high | small | high |

- **Location:** `docs/04-development/setup.md:21-73 (vs docker-compose.yml:2-65, .env.example, apps/web/.env.example)`
- **Why it matters:** setup.md (updated 2026-05-25) documents copying only root .env (Postgres) + apps/api/.env (DATABASE_URL,PORT) and says apps/web/.env is 'none yet'. But docker-compose.yml now starts db + meilisearch + zitadel_db + zitadel; root .env.example requires MEILI_MASTER_KEY and a full ZITADEL_* block; apps/web/.env.example now exists with 5 Auth.js vars. A fresh clone following setup.md gets a crashing Zitadel, no search, and no awareness auth exists — breaking the 'ONE-command setup for an IT generalist' mandate.
- **Recommendation:** Rewrite setup.md to mirror README's correct Develop block: all 3 env files, MEILI_MASTER_KEY + ZITADEL_* set, note db:up now starts Meili+Zitadel, seed, link auth-bootstrap, clarify AUTH_MODE=shim is the zero-config dev default. Bump updated:.

### 3. CTO system-map is materially stale and self-contradictory on auth, search and pending decisions

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | medium | high |

- **Location:** `.claude/skills/lazyit-cto/references/system-map.md (auth §87-101, search §290, debt §306/§316, pending §324-326, frontend §118/§145/§160/§176-178)`
- **Why it matters:** The 'first reference loaded every CTO session' (dated 2026-05-26) still says auth 'Phase 2 complete', /login 'non-functional placeholder', UserSwitcher/acting-user.ts shim live, client.ts injects X-User-Id from localStorage — yet its own line 92 says the shim was removed. It says Meilisearch is 'Not in prod compose' (false: infra/docker-compose.prod.yml:162), lists IdP choice/DB/BYOI as 'Not decided' (decided in ADR-0037), and claims README omits 06-security (false: docs/README.md:37). A stale coordination map causes the CTO to redispatch done work and mis-context subagents.
- **Recommendation:** Full reconciliation pass: mark auth Phases 1-3 + prod wiring done, delete resolved debt/pending rows, fix the frontend table, correct §55 (see ArticleVersion finding), add an updated: date + changelog.

### 4. System-map claims ArticleVersion exists 'via service' — it exists nowhere in the repo

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | quick-win | high |

- **Location:** `.claude/skills/lazyit-cto/references/system-map.md:55 (vs apps/api/prisma/schema.prisma)`
- **Why it matters:** system-map §55 lists 'Article + ArticleVersion (via service)'. Grep confirms ArticleVersion appears in NO Prisma model (schema.prisma has 16 models/6 enums, none ArticleVersion), NO file in apps/api/src, NO file in packages/shared/src. The domain docs are correct (article.md:24 + article-version.md mark it deferred per ADR-0021; the KB ships without versioning). An invented entity in the authoritative state view causes coordination errors and misrepresents the Knowledge pillar's scope.
- **Recommendation:** Change §55 to 'Article (+ .docx import via mammoth)'. Keep ArticleVersion documented only as deferred in domain notes / ADR-0021.

### 5. ADR-0016 is effectively superseded by the auth trio but still labeled 'accepted' with no supersession note

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | quick-win | high |

- **Location:** `docs/03-decisions/0016-auth-strategy-deferred.md:12-13,48-58 and docs/03-decisions/_MOC.md:40`
- **Why it matters:** ADR-0016 body still says 'no authentication yet, endpoints are open (no guards)' and lists IdP choice as TBD. ADR-0037:14,18 explicitly 'Resolves the pending IdP provider choice left open in 0016'; 0038/0039 build on it. Yet _MOC.md:40 shows 0016 plain 'accepted' while the same table annotates 0013→0018 and 0019→0024 supersessions, and the vault convention (_MOC.md:12-13) mandates setting the old status to superseded. ADR-0016 is the doc the README and security files link to, so its stale framing is the root cause of several other drifts.
- **Recommendation:** Set 0016 status to 'superseded by 0037/0039 (auth implemented)' in both the file and _MOC.md:40, add a top 'Superseded by' banner; do not edit the historical decision body (convention).

### 6. Security summary.md and deferred.md still describe a fully unauthenticated API (no guards) as the live posture

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | small | high |

- **Location:** `docs/06-security/summary.md:60-68, docs/06-security/deferred.md:20-46,64-77`
- **Why it matters:** summary.md:62 'lazyit is unauthenticated by decision (ADR-0016) and dev-only' and deferred.md DEF-001/DEF-002 treat 'every endpoint open' and the forgeable X-User-Id shim as live. In code JwtAuthGuard is a global APP_GUARD and ActorService now resolves the actor from a guard-verified User (X-User-Id logic moved into the guard, dev-only). These are the docs an auditor reads; they understate the real posture and mask the new live gap (RBAC: every authenticated user is equal; AUTH_MODE=shim must never reach prod).
- **Recommendation:** Add a sweep entry closing/re-scoping DEF-001/DEF-002, reframe shim mode as dev-only, and open a new finding/ADR for the absent RBAC (the new live authZ gap for an Access-data-holding tool).

### 7. Entity docs describe X-User-Id as the current actor source; it is now @CurrentUser()

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | small | high |

- **Location:** `docs/02-domain/entities/asset-assignment.md:26,49-50,101,106,113; article.md:38-39,92,100,107; access-grant.md; consumable*.md; asset-history.md; asset.md; application.md`
- **Why it matters:** asset-assignment.md:49-50 ('Actor comes from the X-User-Id shim'), article.md:38-39 and access-grant.md (9 refs) describe present-tense actor handling via a forgeable header. Code resolves the actor from the guard-verified User via current-user.decorator.ts; ActorService.resolve(user?) returns user?.id. The authZ rules are unchanged — only the mechanism moved to a verified token (sub→externalId). DEF-002 named this exact post-auth trigger; entity docs are now stale. (ADR bodies referencing X-User-Id are legitimate history — leave them.)
- **Recommendation:** Add a standard callout to each present-tense entity note: actor = authenticated caller via @CurrentUser() (OIDC sub→User); AUTH_MODE=shim resolves it from X-User-Id; never from the body. One mechanical PR.

### 8. apps/api/.env.example omits OIDC_JWKS_URI (read by the guard) and lists OIDC_CLIENT_SECRET (never read by the API)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `apps/api/.env.example (OIDC block) vs apps/api/src/auth/jwt-auth.guard.ts:109,316,332`
- **Why it matters:** jwt-auth.guard.ts reads OIDC_JWKS_URI at :109 (JWKS URL) and :316/:332 (internal-origin rewrite for the Docker split-DNS case) but it is absent from apps/api/.env.example. The example lists OIDC_CLIENT_SECRET, which the API never reads (only ISSUER/JWKS_URI/CLIENT_ID); the client secret is the web's AUTH_CLIENT_SECRET (auth.ts:89). OIDC_JWKS_URI is the exact knob the prod-OIDC gotcha required, so omitting it re-exposes a solved trap.
- **Recommendation:** Add OIDC_JWKS_URI with a comment (Docker split-DNS internal JWKS URL; else derived from OIDC_ISSUER). Remove or comment OIDC_CLIENT_SECRET as 'unused by the API; lives in apps/web/.env as AUTH_CLIENT_SECRET'.

### 9. apps/web/.env.example uses the v4-era NEXTAUTH_URL and omits the required AUTH_INTERNAL_ISSUER

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | quick-win | high |

- **Location:** `apps/web/.env.example (auth block) vs apps/web/auth.ts:42 and system-map §100`
- **Why it matters:** The example sets NEXTAUTH_URL, but Auth.js v5 reads AUTH_URL (system-map §100 confirms AUTH_URL + AUTH_TRUST_HOST as the required vars; no NEXTAUTH_URL/AUTH_URL reference exists in apps/web TS — v5 reads AUTH_* implicitly). auth.ts:42 reads AUTH_INTERNAL_ISSUER (the Docker external→internal issuer rewrite, the key to split-DNS login) which is not in the web example at all. Setting NEXTAUTH_URL risks the 0.0.0.0:3000 callback failure the system-map §97 warns about.
- **Recommendation:** Rename NEXTAUTH_URL→AUTH_URL, add AUTH_TRUST_HOST=true and a commented AUTH_INTERNAL_ISSUER explaining the Docker case; keep bundled-Zitadel dev defaults working.

### 10. code-conventions.md says 'shadcn/ui not yet installed' and the load-bearing heroicons-only rule is undocumented in docs/

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | small | medium |

- **Location:** `docs/04-development/code-conventions.md:56-58; docs/04-development/workflows.md:1-9`
- **Why it matters:** code-conventions.md:56-58 still calls shadcn/ui 'the planned component layer (not yet installed)', contradicting reality (it is installed; system-map §113-114). The real frontend convention 'heroicons in app code; lucide only inside components/ui/*' lives ONLY in the CTO system-map and the briefing — a frontend agent reading code-conventions.md would never learn it and would import the wrong icon set. workflows.md is also frozen at the project's earliest date (2026-05-25) through 26 ADRs of change. (The int4() rule, by contrast, is correctly documented at :31-33.)
- **Recommendation:** Mark shadcn/ui installed, add the heroicons-only rule with rationale + ADR-0011/0020 links; reconcile workflows.md against docs/05-runbooks/git-workflow.md; bump dates.

### 11. status_may_2026/ vault subtree breaks the vault's own _MOC + frontmatter navigability convention

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | low | small | high |

- **Location:** `docs/status_may_2026/ (18 subfolders) vs docs/README.md:40-51`
- **Why it matters:** docs/README.md:51 mandates a _MOC.md per folder and :43-44 mandates YAML frontmatter on every note. The new status_may_2026/ tree has 18 area subfolders but no top-level _MOC, and existing analyses (e.g. backend-search-subsystem/analysis.md:1) have a plain H1+subtitle and no frontmatter. As these per-area analyses accumulate each review cycle they become an un-navigable, un-indexed dumping ground in Obsidian — the exact 'does the vault stay navigable as it grows' risk this audit targets.
- **Recommendation:** Add docs/status_may_2026/_MOC.md indexing all 18 areas with coverage dates, and prepend the standard frontmatter block to each analysis.md (the H1+subtitle format itself is fine).

## Quick wins

- README.md:61-63 — replace the false 'auth deferred / unauthenticated / must not be exposed publicly' blockquote with the current OIDC posture (bundled Zitadel, BYOI by 3 vars, AUTH_MODE=shim dev-only, link ADR-0037/0039 + auth-bootstrap runbook).
- CTO system-map §55 — drop '+ ArticleVersion (via service)'; ArticleVersion exists in no model, no src, no shared.
- ADR-0016 + docs/03-decisions/_MOC.md:40 — set status to 'superseded by 0037/0039 (auth implemented)' and add a banner, matching the convention already used for 0013/0019.
- apps/api/.env.example — add OIDC_JWKS_URI (read by the guard at jwt-auth.guard.ts:109/316/332); comment/remove the unused OIDC_CLIENT_SECRET.
- apps/web/.env.example — rename NEXTAUTH_URL→AUTH_URL, add AUTH_TRUST_HOST=true and a commented AUTH_INTERNAL_ISSUER (read by auth.ts:42).
- code-conventions.md:56-58 — mark shadcn/ui installed and add the heroicons-only (lucide only in components/ui/*) rule, currently undocumented anywhere in docs/.
- CTO system-map — delete the already-resolved known-debt/pending rows (Meili-in-prod §306, README-06-security §316, IdP-not-decided §324-326) and the login-placeholder/shim frontend rows (§118/§145/§160/§176-178).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._

---

## Round 1 implementation (CTO proposal)

Schema-free truth-in-advertising pass — closes the high/medium docs-drift findings that ship with
the operator (findings 1, 2, 5, 8, 9, 10). Branch `docs/fix-auth-and-env-drift`.

- **Finding 1 — README auth posture (high).** Replaced the false "auth deferred / unauthenticated /
  must not be exposed publicly" blockquote with an **Authentication** section stating the real
  posture: OIDC via bundled Zitadel, BYOI by 3 env vars, `AUTH_MODE=shim` as the zero-config dev
  default, links to ADR-0037/0039 + `auth-bootstrap.md`, and a kept "never run prod with
  `AUTH_MODE=shim`" warning. Also corrected the stale per-env-file comments in the Develop block.
- **Finding 2 — setup.md no longer yields a working dev env (high).** Rewrote the Steps + Environment
  sections: all **3** env files, `MEILI_MASTER_KEY` + the `ZITADEL_*` block in root `.env`, a note
  that `bun run db:up` now starts Postgres + Meilisearch + Zitadel (+ its own Postgres), the seed
  step, an `AUTH_MODE=shim` dev-default callout linking `auth-bootstrap`, and a complete env-var
  table. Bumped `updated:` to 2026-05-30.
- **Finding 5 — ADR-0016 supersession (medium).** Set ADR-0016 status to `superseded` (frontmatter +
  Status section) with a "Superseded by 0037/0039" banner and a warning that its body describes a
  pre-auth world; the historical decision body is untouched (vault convention). Updated
  `docs/03-decisions/_MOC.md` row 0016 to match the 0013/0019 annotation style.
- **ADR-0022/0023/0024 banners.** Added "shim path preserved; superseded in OIDC path by 0038"
  callouts to each (matching the 0013/0019 convention), annotated their `_MOC.md` rows, and bumped
  their `updated:` dates. Authorization rules unchanged — only the actor *source* moved to a
  verified token in OIDC mode; `X-User-Id` survives only under `AUTH_MODE=shim`.
- **Finding 8 — apps/api/.env.example (low).** Added `OIDC_JWKS_URI` (commented; explains the Docker
  split-DNS internal-JWKS case read by `jwt-auth.guard.ts`, otherwise derived from `OIDC_ISSUER`),
  documented `OIDC_CLIENT_ID` audience behaviour, and replaced the unused `OIDC_CLIENT_SECRET` with a
  note that the API reads no client secret (it lives in the web's `AUTH_CLIENT_SECRET`).
- **Finding 9 — apps/web/.env.example (low).** Renamed v4-era `NEXTAUTH_URL` → `AUTH_URL`, added
  `AUTH_TRUST_HOST=true`, and added a commented `AUTH_INTERNAL_ISSUER` documenting the Docker
  external→internal issuer rewrite read by `apps/web/auth.ts`.
- **Finding 10 — code-conventions.md (low).** Marked shadcn/ui **installed** (vendored in
  `components/ui/*`) and documented the load-bearing **heroicons-only** rule (lucide stays inside
  `components/ui/*`; no third icon set), which previously lived only in the CTO system-map. Bumped
  `updated:`.

Verified all new wiki-links and README relative links resolve. **No schema/migration change.**

Out of scope here (other lanes / deferred): finding 3 (CTO system-map, `.claude/` — not in this
lane), finding 4 (ArticleVersion, system-map), finding 6 (`docs/06-security/**` — security lane),
finding 7 (entity docs under `docs/02-domain/**` — separate mechanical PR), finding 11
(`docs/status_may_2026/_MOC` + per-analysis frontmatter — vault-hygiene follow-up).
