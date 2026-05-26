# DevOps Task Template

> Template for dispatching infrastructure, CI, deployment, or operational tooling work. The agent loads the `lazyit-devops` skill.
>
> **How to use**: same as the other templates.

---

```markdown
# <Task title in 5-10 words>

## Objective

<One line. What infrastructure or operational change is delivered.>

## Context

<2-4 sentences. Why this work is needed now. Reference ADRs, runbooks, or operational findings.>

Relevant references:
- `docs/03-decisions/0025-containerization.md` (or relevant ADR)
- `docs/05-runbooks/<runbook>.md`
- `infra/README.md`

## CEO intent (verbatim if a direct quote)

> "<exact CEO words, if applicable>"

## Scope

**In scope**:
- <Service being added or modified>
- <CI workflow changes>
- <Runbook authored or updated>
- <Reverse proxy or TLS adjustment>

**Explicitly out of scope**:
- <Application code changes (unless cross-lane authorized; see below)>
- <Stack additions not approved>

## Lane

**You may touch**:
- `infra/**`
- `.github/workflows/**`
- Root `docker-compose.yml`
- `docs/05-runbooks/**`
- `docs/03-decisions/**` (for infrastructure ADRs)

**You must NOT touch**:
- `apps/api/**` and `apps/web/**` (unless cross-lane authorized below)
- `packages/shared/**`

## Cross-lane authorization (if applicable)

<Only fill in if the task genuinely requires touching application code, e.g., adding env variable usage. Otherwise remove this section.>

You are authorized to make the following minimal change(s) outside your normal lane:
- `<file path>` — <what change> — reason: <why infra requires it>

Mark the commit message clearly: `chore: <change> [authorized cross-lane edit for <reason>]`.

## Concurrent work declaration

<Same as other templates>

## Operational constraints

The deployment philosophy is **operator-friendly self-hosted first**. The operator profile is an IT generalist who can edit `.env` and run `docker compose up -d`, not a platform engineer.

- Maintain "one command to start" experience
- All configuration via `.env` files; no YAML templating
- Defaults must be safe and sensible
- Errors must be actionable and loud
- Health checks on every service
- No required outbound calls to our infrastructure
- Document any operational impact in the relevant runbook

## Acceptance criteria

1. <Service is healthy and reachable as expected>
2. <CI passes end-to-end>
3. <Runbook updated>
4. <Local verification commands documented>
5. <Production-like compose validated (if applicable)>

## Verification expected

Be concrete. DevOps work fails silently if not verified.

- `docker compose -f <file> up -d --build` and observe health
- `curl <endpoint>` against the new service
- CI green on the branch
- Specific runbook command sequences executed

## Documentation required

- ADR: <yes/no — usually yes for new services or structural changes>
- Runbook: <which one is created or updated>
- README updates: `infra/README.md`, root `README.md`, or `docs/05-runbooks/_MOC.md`

## Workflow

Standard git workflow. Same as backend.

## Reporting

When you finish:

1. **Summary**: 3-5 lines
2. **Files changed**: list
3. **Verification performed**: actual commands and observed output
4. **CI status**: link or screenshot of the green run
5. **Operational notes**: anything the operator needs to know
6. **Cross-lane edits made**: if any, with justification recap
7. **Debt or follow-ups**: noticed but not fixed
8. **Frictions**: anything that broke

Do NOT open the PR until I confirm. Wait for my OK.

## When to stop and ask

- Any new external service (vendor lock-in implications)
- Any dependency on outbound network at runtime
- Any breaking change to the operator's expected workflow
- Any conflict with the operator profile expectations
- Any cross-lane edit not listed in this prompt

Raise with 🚨.
```

---

## CTO-side fill checklist

- [ ] Cross-lane authorization is present only if genuinely needed
- [ ] Operational constraints section is intact
- [ ] Verification commands are realistic and concrete
- [ ] Operator impact is considered
- [ ] No bracketed leftover text remains