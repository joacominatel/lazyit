# Agents Roster

> This document lists every subagent the CTO may dispatch. Each entry is the "personnel file" the CTO consults when deciding who to assign a task to.
>
> **Owner**: CTO. Updated when an agent is added, removed, or its scope changes. Updates require CEO approval (creating or modifying agent roles is a CEO decision).
>
> **Not redundant with the individual SKILL.md files** of each subagent: those define how each agent operates internally. This file is the **cross-cutting catalog** the CTO uses to choose between them.

---

## How the CTO uses this file

When dispatching a task, the CTO:
1. Identifies the lane the task belongs to (which files will be touched)
2. Scans this roster for an agent whose primary lane matches
3. Confirms the agent has no hard exclusion on the task
4. Uses the corresponding prompt template from `prompt-templates/`
5. Dispatches with full context, expecting the agent to honor its lane

If no agent fits the task, **the CTO escalates to the CEO** before inventing a new role.

---

## Concurrency rules

This roster also informs **parallel-dispatch decisions**. The CTO uses three tiers:

### Tier 1 — Strict serial (default)

One agent (or one coordinated group on the same issue) works, finishes, PR merges, then the next is dispatched. Always safe.

**Use when**:
- The task is in a single lane and there are no other safe parallel tasks
- The next task depends on the current one's result
- The CTO is unsure about lane overlap
- The CEO is the bottleneck on review and parallel work would only stall

### Tier 2 — Parallel cross-lane, verified disjoint

Two agents work simultaneously on truly non-overlapping file sets. The CTO must verify this before dispatching.

**Use when**:
- Tasks are in clearly different lanes (e.g., `apps/api/*` vs `infra/*`)
- Neither task creates or modifies a "shared crit file" (see below)
- Each agent's PR can be reviewed and merged independently

**Shared crit files that block parallel dispatch**:
- `packages/shared/src/index.ts` (barrel)
- `apps/api/src/app.module.ts` (module registry)
- `apps/web/components/sidebar-nav.tsx` (nav items)
- `apps/web/app/(app)/layout.tsx` (layout)
- `bun.lock` and `package.json` (root)
- `docs/03-decisions/_MOC.md` (ADR numbering)
- `docker-compose.yml` (services)

If a task touches any of these, the CTO defaults to Tier 1.

### Tier 3 — Coordinated parallel within one issue

Multiple agents collaborate on a single issue, each in their own lane, opening separate PRs that collectively close the issue.

**Use when**:
- Time matters and confidence is high
- The issue genuinely spans lanes (e.g., a feature requiring backend + frontend in lockstep)
- Each agent's deliverable is independently verifiable

**Requires**: CEO sign-off before dispatch.

---

## Agent: `lazyit-navigator` (used by backend and frontend agents)

> Despite the name, `lazyit-navigator` is the **operational skill** loaded by feature-development agents — both backend and frontend. It is not a distinct agent on its own; it's the SKILL invoked by an agent working on a feature.

### Backend agent (using `lazyit-navigator`)

**Primary lane**:
- `apps/api/**`
- `packages/shared/**` (schemas, types, utilities)
- `docs/02-domain/**` (entity notes)
- `docs/03-decisions/**` (new ADRs)

**Forbidden lane**:
- `apps/web/**`
- `infra/**`
- `.github/**`
- Other agents' SKILL files

**Strengths**:
- NestJS module structure, controllers, services
- Prisma schema and migrations
- zod schema design
- Service-layer business logic
- Test writing (jest + bun test)
- ADR drafting for backend decisions

**Limitations**:
- Does not coordinate with frontend changes — that's the CTO's role
- Should not make architectural decisions (escalate via CTO)
- Tests sometimes need Node userland setup if running locally

**Best for**:
- New entities, endpoints, modules
- Refactors within a service
- Schema additions and migrations
- Backend-only bug fixes

**Avoid for**:
- UX or design decisions (no judgment of UI consequences)
- Infrastructure changes
- Documentation-only tasks (use a doc-focused dispatch)

---

### Frontend agent (using `lazyit-navigator`)

**Primary lane**:
- `apps/web/**`
- `packages/shared/**` (consume only; rarely add)
- `docs/02-domain/**` (UI-related entity notes)
- `docs/03-decisions/**` (frontend ADRs)

**Forbidden lane**:
- `apps/api/**`
- `infra/**`
- `.github/**`

**Strengths**:
- Next.js App Router patterns
- shadcn/ui composition
- TanStack Query data flows
- Form patterns (react-hook-form + zod)
- Theming, dark mode, layouts
- Established ADR-0020 mold (endpoint → hook → page)

**Limitations**:
- Should not invent new entities (escalate to CTO)
- UX decisions of significant scope should be escalated (e.g., navigation restructure)
- Must avoid lucide-react outside `components/ui/*`
- Avoids server actions unless explicitly approved (CTO call)

**Best for**:
- New screens that materialize backend capability
- Improving existing screens
- Adding components to the shared UI library
- Implementing search/filter/sort UX

**Avoid for**:
- Backend or schema work
- Infrastructure work
- New navigation architecture without CEO approval

---

## Agent: `lazyit-devops`

**Primary lane**:
- `infra/**`
- `.github/workflows/**`
- Root `docker-compose.yml`
- `Caddyfile` and reverse proxy config
- `docs/05-runbooks/**` (operational runbooks)

**Forbidden lane**:
- `apps/api/**` (except when explicitly authorized — see "cross-lane edits")
- `apps/web/**` (with rare exceptions like `next.config.ts` for build settings)
- `packages/shared/**`

**Strengths**:
- Docker images, multi-stage builds
- docker-compose orchestration
- Reverse proxy configuration
- CI/CD workflows
- Health checks and observability
- Secrets and env management
- Deployment runbooks

**Limitations**:
- No direct application code changes — must request authorization for cross-lane edits
- Decisions affecting deployment story (new external service, vendor) escalate to CTO
- Custom infrastructure (Kubernetes, etc.) is out of scope for this product

**Best for**:
- Adding services to the prod compose
- CI workflow changes
- Reverse proxy and TLS work
- Deployment guidance and runbooks
- Operational debugging (health checks, log structure consumption)

**Avoid for**:
- Business logic changes
- Database schema changes
- UI work

**Cross-lane edits**: explicit CEO/CTO authorization required. The agent marks the commit message clearly.

---

## Agent: `lazyit-sentinel`

**Primary lane (read-only on code)**:
- Reads all of `apps/api/**`, `apps/web/**`, `packages/shared/**`, `infra/**`
- Writes only to `docs/06-security/**` (findings, MOCs, summaries)

**Forbidden actions**:
- Modifying application code (writes findings; remediator implements fixes)
- Modifying infrastructure
- Modifying other agents' SKILL files

**Strengths**:
- Blue-team security review
- Identifying vulnerabilities (XSS, injection, auth bypass, DoS, data exposure)
- Tracking findings with severity, location, reproduction
- Maintaining the security MOC

**Limitations**:
- No fixes — the remediator owns remediation
- Findings should be actionable, not speculative
- Severity calls should be conservative; the CTO judges escalation

**Best for**:
- Periodic security sweeps
- Pre-release security review
- Reviewing newly-introduced surfaces (new endpoints, new file uploads, etc.)
- Auditing post-major-change

**Avoid for**:
- Anything that requires modifying code

---

## Agent: `lazyit-remediator`

**Primary lane**:
- Application code in `apps/api/**` and `packages/shared/**` (for security fixes)
- `docs/06-security/**` (moves findings issues/ → closed/ with Resolution)
- ADRs when a finding's fix establishes a policy

**Forbidden lane**:
- `apps/web/**` (frontend security fixes need explicit cross-lane authorization)
- `infra/**` (infra security findings escalate to DevOps)

**Strengths**:
- Implementing fixes for sentinel findings
- Writing focused tests around the fix
- Surfacing findings that are out-of-lane (for redirection)
- Triage notes for findings that escalate

**Limitations**:
- Does not write new features; fixes only
- Does not modify business logic beyond what the fix requires
- Escalates "structural" fixes (requiring queues, new services, big refactors) to CTO

**Best for**:
- Closing security findings
- Defensive programming additions tied to a finding
- Updating ADRs to reflect security policy

**Avoid for**:
- General refactoring
- Feature work
- Documentation-only tasks

---

## Agent: documentation specialist (ad-hoc)

> Not a permanent role. Spawned occasionally for doc-only tasks. Has no dedicated SKILL.md beyond `lazyit-navigator`.

**Primary lane**:
- `docs/**`
- `README.md` files
- `CLAUDE.md`
- `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`

**Forbidden lane**:
- All application code
- Other agents' SKILL files (unless task is specifically to update them; CEO approval)
- Infrastructure

**Best for**:
- Workflow document updates
- Runbook creation
- ADR cleanup and indexing
- Template authoring

---

## Special cases

### When a task spans multiple agents naturally

Examples:
- Adding auth: devops (IdP setup) + backend (OIDC integration) + frontend (login flow) + remediator (cleanup)
- Adding a new feature with UI: backend (endpoints) + frontend (screens)

**Default**: serial dispatch (Tier 1) — first agent, then the next, with merges between.

**Optional**: parallel where lanes truly don't overlap (Tier 2), or coordinated parallel under one issue (Tier 3 with CEO approval).

### Validated pattern for high-stakes, multi-wave epics (RBAC v2 + Service Accounts, 2026-06-03)

For a large, security-sensitive epic, this orchestration worked end-to-end and is the CTO's preferred shape:

1. **Read-only design/audit workflow first** — a fan-out audit/design pass produces the contract + the fork list, touching no code.
2. **CEO forks** — the CEO resolves the open design decisions; the CTO turns them into ordered tasks.
3. **Serialized implementation waves** — dependency-ordered (e.g. shared catalog/schema → backend resolver/guard → frontend gating → security close-outs), contracts landing before their consumers.
4. **An adversarial multi-agent review gates each wave before merge** — a correctness reviewer + `lazyit-sentinel`, **with verification**, run against the wave's diff; the wave merges only after both pass.

This is the "fan-out read-only audit, then serialize the build by dependency" pattern (already noted in `decision-history`), now hardened with a per-wave adversarial review gate. **No agent scope changed** to enable it — it's purely an orchestration choice the CTO makes.

### When the CTO discovers a missing capability

If a category of work doesn't fit any agent (e.g., end-to-end testing, performance benchmarking, design systems specialization), the CTO:
1. Notes it in escalation to CEO
2. Proposes either: (a) extending an existing agent's scope, or (b) creating a new role with its own SKILL
3. Waits for CEO decision before proceeding

### When an agent's actual behavior diverges from its roster entry

If during dispatch the CTO notices that an agent's actual SKILL.md contradicts this roster, **trust the SKILL.md** (it's the source of truth for the agent) and update this roster to match. If the contradiction looks unintentional (the SKILL drifted), flag it to the CEO in retrospective.

---

## Update protocol

The CTO updates this roster when:
- An agent's SKILL.md changes in a way that alters its scope
- A new agent is added (requires CEO approval)
- An agent is retired (requires CEO approval)
- The shared crit files list changes (e.g., new layout root, new shared barrel)

Updates are CEO-visible. The roster is not a private document.