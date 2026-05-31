# Infrastructure — Docker images, compose topology, Caddy, CI/CD

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Infrastructure**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The container/Caddy/CI stack is thoughtfully built and secure-by-default, but it has no real release/CD path, ships unpinned base images, a broken first-deploy reindex command, and infra docs that still claim auth/search are "not configured."

## Findings (10)

### 1. Documented first-deploy reindex command cannot run — API runtime image has no Bun

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | high | small | high |

- **Location:** `docs/05-runbooks/deploy-self-hosted.md:67; apps/api/package.json:17; apps/api/scripts/reindex-all.ts:11; infra/docker/api.Dockerfile:40,49-53`
- **Why it matters:** The deploy runbook's one-command search-population step fails on a node:26-alpine image with a cryptic 'bun: not found', and the .ts script + scripts/ dir are never copied into the runtime stage. Violates the one-command-setup / loud-actionable-errors mandate.
- **Recommendation:** Compile the reindex script into dist/ and run it via Node (node apps/api/dist/scripts/reindex-all.js), or run the initial reindex from the Bun-based migrate job / a dedicated one-shot service. Fix the runbook command accordingly.

### 2. Base images are tagged, not digest-pinned — builds are not reproducible

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | high | small | high |

- **Location:** `infra/docker/api.Dockerfile:8,31,40; web.Dockerfile:8,30; migrate.Dockerfile:8; infra/docker-compose.prod.yml:18,93,124,163,178`
- **Why it matters:** Every base/service image uses a mutable tag (node:26-alpine, caddy:2-alpine, postgres:18-alpine, getmeili v1.12.3, zitadel v2.68.0, oven/bun:1.3.14). ADR-0025 itself lists digest pinning as a deferred follow-up. node:26-alpine is a rolling Current-line tag that changes under the build — breaks reproducible self-host installs and is the cheapest supply-chain hardening.
- **Recommendation:** Pin every base image by image@sha256:digest with the tag kept in a comment; renew via Dependabot/Renovate. Closes the deferred ADR-0025 follow-up without re-litigating it.

### 3. Infra docs are stale — still describe auth/IdP/Meilisearch as 'not configured / reserved'

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| docs | medium | quick-win | high |

- **Location:** `infra/README.md:58-63; docs/01-architecture/deployment.md:37,69-74; docs/05-runbooks/deploy-self-hosted.md:15-18,98-103; docs/05-runbooks/docker-prod-like-first-boot.md:47,51`
- **Why it matters:** Meilisearch and Zitadel are fully wired into prod compose + Caddyfile (PR #58/#60), yet infra/README, deployment.md, and the deploy runbook still say 'No IdP is wired', carry a now-false 'unauthenticated build, do not expose' banner, and the prod-like first-boot verification expects GET /api/users -> 200 when the global JWT guard now returns 401. CLAUDE.md mandates docs stay in sync.
- **Recommendation:** One doc-refresh pass: remove reserved-IdP sections, add Zitadel+Meili+Caddy to the topology diagram, delete the unauthenticated-build warning, fix verification curls to expect 401 (or show a Bearer example).

### 4. CI lint is non-blocking debt and the Docker build runs on every push without leverage

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | medium | high |

- **Location:** `.github/workflows/ci.yml:70-78,93-128`
- **Why it matters:** Both lint steps have continue-on-error:true (~168-warning debt never fails CI), so regressions hide in noise. The docker job builds all three images with push:false on every PR/push, producing nothing consumable and paying the build tax on doc/frontend-only PRs.
- **Recommendation:** Burn down lint debt per-workspace then drop continue-on-error to make lint blocking (per ADR-0027 plan); gate the docker job with a paths filter or to dev/master push only.

### 5. No release/CD path or GHCR publishing — every upgrade is a from-source rebuild on the customer host

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | large | high |

- **Location:** `.github/workflows/ci.yml:104-128; docs/03-decisions/0027-ci-pipeline.md:50-55; docs/05-runbooks/deploy-self-hosted.md:84-87`
- **Why it matters:** CI builds with push:false and the documented update flow is 'git pull && up -d --build' — customers compile three images (incl. next build + bun install) on prod, need the full toolchain + source on the box, and have no immutable artifact to roll back to. This is the central gap between 'it runs' and 'a small IT team can operate it' per the CEO vision.
- **Recommendation:** PROPOSAL: write the deferred CD ADR and add release.yml that builds + pushes versioned (semver + SHA) images to GHCR on v* tags; ship a pull-based prod compose so upgrades are 'docker compose pull && up -d' with rollback. Sequence after digest pinning.

### 6. No resource limits, log rotation, or restart caps — one container can starve the single host

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | small | high |

- **Location:** `infra/docker-compose.prod.yml (all services); docker-compose.yml (all services)`
- **Why it matters:** No service in either compose sets mem_limit/cpus or a logging driver with rotation. On the single-host small-team target, an unbounded Meili/Postgres spike or a crash-loop with verbose json-file logs can OOM the box or fill the disk, taking down the whole company's IT tool — the classic self-host 3am failure.
- **Recommendation:** Add modest mem_limit/cpus per service and a logging: block (max-size 10m, max-file 3) to every long-running service. Cheap, high-value operability guardrail.

### 7. Committed-style local .env.prod holds real secrets at world-readable 0644

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | medium | quick-win | high |

- **Location:** `infra/env/.env.prod (mode 644; git log --all confirms never committed)`
- **Why it matters:** git history is clean (.env.prod never committed — good), but on disk it is mode 644 (world-readable) with concrete weak secrets (Argentina1!, Admin1234!, live MEILI/ZITADEL/AUTH keys) despite the runbook instructing chmod 600. ADR-0028's whole posture relies on host-file protection and the canonical example doesn't follow it.
- **Recommendation:** chmod 600 now and rotate the weak dev secrets; add a preflight that refuses to start if .env.prod is group/other-readable or still contains CHANGE_ME — a loud guard enforcing ADR-0028 without a secrets manager.

### 8. CI runtime/build Node skew (24 vs 26) and missing turbo/Next build cache

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | low | small | high |

- **Location:** `.github/workflows/ci.yml:35,90-91; apps/api/package.json:52; infra/docker/api.Dockerfile:40; web.Dockerfile:30`
- **Why it matters:** CI runs Node 24 and @types/node is ^24, but runtime images are node:26-alpine — code is typechecked/tested against a different Node than it runs on, a latent reproducibility bug. CI also lacks turbo cache (turbo build recomputes everything) and Next .next/cache, leaving free CI time on a monorepo built for incrementality.
- **Recommendation:** Align the toolchain (bump CI setup-node + @types/node to 26 to match the runtime, or document the deliberate skew in ADR-0025) and add turbo + .next/cache caching in CI.

### 9. No dependency-update automation, image scanning, or SBOM

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | small | high |

- **Location:** `.github/ (only ci.yml + templates present)`
- **Why it matters:** .github/ has no dependabot.yml/Renovate and CI has no Trivy/docker-scout/audit step; combined with unpinned base images, nothing watches for a CVE in postgres/caddy/zitadel or the dep tree. A self-hosted tool holding Access-pillar data needs maintenance signal — no-telemetry does not mean no-security-maintenance (all runs in CI, no phone-home).
- **Recommendation:** Add dependabot.yml (or Renovate) for the Bun/npm manifests + Dockerfiles + Actions, and a non-blocking Trivy/docker-scout scan in CI that hardens to blocking-on-HIGH once triaged.

### 10. Caddy lacks security headers (HSTS/nosniff/referrer) and depends_on only service_started

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| security | low | quick-win | medium |

- **Location:** `infra/caddy/Caddyfile:11-58; infra/docker-compose.prod.yml:188-193`
- **Why it matters:** The single public ingress sets no HSTS/X-Content-Type-Options/Referrer-Policy/CSP — defense-in-depth that matters now that auth landed and the stack can be internet-exposed, and intersects the deferred stored-XSS risk (SEC-003). Caddy also depends_on api/web with service_started not service_healthy, leaving a cold-start 502 window despite both having healthchecks.
- **Recommendation:** Add a header block (HSTS gated to the real-domain site block only, plus nosniff + referrer-policy) and switch Caddy depends_on to condition: service_healthy. Coordinate a CSP with the frontend/Sentinel lanes.

## Quick wins

- Refresh the stale infra docs: remove the 'reserved IdP / not configured' sections, fix the false 'unauthenticated build, do not expose' warning, and correct the first-boot verification curls (now 401, not 200); add Zitadel+Meilisearch+Caddy to the topology diagram.
- chmod 600 infra/env/.env.prod and rotate the weak local secrets (Argentina1!, Admin1234!) to match the runbook ADR-0028 requires.
- Digest-pin every base image (3 Dockerfiles + 2 compose files) with the tag kept as a comment — closes the deferred ADR-0025 follow-up and the biggest reproducibility gap.
- Add a logging: rotation block (max-size 10m, max-file 3) and modest mem_limit/cpus to every long-running compose service to prevent disk-full / OOM on the single host.
- Add Caddy security headers (HSTS on real-domain only, X-Content-Type-Options nosniff, Referrer-Policy) and a JSON access-log block; switch Caddy depends_on to condition: service_healthy to kill the cold-start 502 window.
- Drop the hardcoded lazyit-*:dev image tags in the prod compose so versions don't collide and 'what is deployed' is answerable.

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
