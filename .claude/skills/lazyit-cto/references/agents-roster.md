# Project skill lenses

Worker lifecycle and role contracts belong to the global `cto` and `hc` skills. The entries
below are project expertise to load into an interactive worker, not native agent types or hc
template names. Use the charter for current lanes and merge authority; any older examples
below yield to it. The coordinator composes the role and names exact skill paths in the task.
Each writer gets its own worktree and index. No nested delegation unless explicitly assigned.

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
