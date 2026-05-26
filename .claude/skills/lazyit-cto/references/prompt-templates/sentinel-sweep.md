# Sentinel Sweep Template

> Template for dispatching the `lazyit-sentinel` agent. The sentinel is **read-only on code**; it produces findings, not fixes. Findings are remediated separately by `lazyit-remediator`.
>
> **How to use**: same as the other templates.

---

```markdown
# Security sweep: <scope name>

## Objective

Perform a blue-team / vulnerability-research review of <scope>. Produce findings in `docs/06-security/issues/`, updated MOC and summary.

**You do not fix anything in this sweep.** Fixes are a separate task for the remediator.

## Context

<2-4 sentences. Why this sweep is being run. Recently-changed surfaces, post-epic review, scheduled audit, etc.>

Relevant references:
- `docs/06-security/_MOC.md` — current state
- `docs/06-security/summary.md` — counts and severity breakdown
- <Recent PRs or epics that introduced new surfaces, if applicable>

## CEO intent (verbatim if a direct quote)

> "<exact CEO words, if applicable>"

## Scope of the sweep

**You may read**:
- `apps/api/**`
- `apps/web/**`
- `packages/shared/**`
- `infra/**`
- `docker-compose*.yml`
- `.github/workflows/**`

**Focus areas for this sweep** (highest signal):
- <Specific module, endpoint family, or surface to inspect first>
- <e.g., "Newly-added /consumables endpoints" or "Auth shim usage across services">
- <Optional: anything explicitly NOT covered, with reasoning>

**You may write only to**:
- `docs/06-security/issues/<finding-id>.md` (new findings)
- `docs/06-security/_MOC.md` (index)
- `docs/06-security/summary.md` (counts)

**You must NOT modify**:
- Any code in `apps/`, `packages/`, `infra/`
- Other agents' SKILL files
- ADRs (unless the CTO explicitly authorizes a security-policy ADR draft)

## Categories of concern to look for

The standard catalog (not exhaustive — use judgment):

- Authentication and authorization bypass
- Injection (SQL, NoSQL, command, template)
- XSS sinks (especially in markdown rendering, HTML constructed from user input)
- Insecure direct object references (IDOR)
- Mass assignment / over-posting
- Path traversal
- File upload abuses (DoS via decompression, executable content, size limits)
- Information disclosure (PII in logs, verbose error responses, exposed metadata)
- CSRF on state-changing endpoints
- Insecure defaults (open binds, weak secrets, missing TLS)
- Dependency vulnerabilities (advisory checks on direct deps)
- Race conditions and transaction integrity gaps
- Soft-delete bypass or restoration vulnerabilities
- Search index leakage (drafts, restricted entities)

## Per-finding format

Each finding goes in `docs/06-security/issues/SEC-<NNN>.md` with:

```
# SEC-<NNN>: <Short title>

**Severity**: 🔴 Critical | 🟠 Medium | 🟡 Low | ⚪ Info
**Category**: <from list above>
**Affected**: <file path(s) and line numbers when concrete>
**Discovered**: <date and sweep name>

## Description

<What the issue is, why it matters, what the impact would be if exploited.>

## Reproduction

<Concrete steps or example. For a code-level finding, the relevant snippet with line refs.>

## Recommended remediation

<High-level direction for the remediator. NOT an implementation. The remediator decides specifics.>

## Notes

<Anything else: dependencies on other findings, why severity was set this way, alternative interpretations.>
```

## Acceptance criteria

1. All in-scope code has been read attentively
2. Each finding has a unique ID, severity, and remediation direction
3. MOC and summary reflect the new findings
4. No fixes were attempted

## Severity calibration (be conservative)

- **🔴 Critical**: exploitable now, leads to data loss, full bypass, or RCE. Escalate immediately via the CTO.
- **🟠 Medium**: exploitable under realistic conditions, requires non-trivial effort, impacts security posture.
- **🟡 Low**: bad practice or latent risk; not directly exploitable today but could become one.
- **⚪ Info**: defensible improvement, hardening suggestion, observation.

When in doubt, prefer lower severity with a clear note explaining the calibration.

## Workflow

Standard git workflow:
1. Issue: create one or claim existing
2. Branch from `dev`: `chore/issue-<N>-sentinel-sweep-<scope>`
3. File-by-file commits with `docs:` prefix (findings are docs)
4. Push, open PR to `dev`

## Reporting

When you finish:

1. **Summary**: scope covered, time spent, files reviewed
2. **New findings**: count by severity, IDs assigned
3. **Critical findings**: detailed for each (severity, location, recommendation) — **escalate critical findings immediately** before continuing the sweep
4. **Closed-out areas**: surfaces you reviewed and found clean
5. **Out-of-lane observations**: anything in infra or app code that's not a security issue but you noticed (one line each, no action)
6. **Frictions**: anything that slowed the sweep

Do NOT open the PR until I confirm. Wait for my OK.

## When to stop and ask

- Critical finding discovered (escalate immediately, do not wait for full sweep)
- Ambiguity about whether something is a finding or a design choice — surface for CTO judgment
- Scope unclear (e.g., a finding spans multiple lanes)
- A finding suggests a structural change (queue, new service) — surface to CTO

Raise with 🚨.
```

---

## CTO-side fill checklist

- [ ] Scope is bounded (a sweep of "everything" is rarely useful; specify focus)
- [ ] The "you do not fix" instruction is intact
- [ ] Severity calibration section is intact
- [ ] No bracketed leftover text remains