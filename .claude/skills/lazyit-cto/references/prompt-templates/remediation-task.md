# Remediation Task Template

> Template for dispatching the `lazyit-remediator`. The remediator closes findings from `docs/06-security/issues/`. Each remediation is **focused, defensive, and accompanied by tests**.
>
> **How to use**: same as the others. The remediator may be dispatched for one finding at a time or for a batch — be explicit.

---

```markdown
# Remediate: <one or more SEC-NNN findings>

## Objective

Close the listed security findings by implementing focused fixes with tests, and move each finding from `docs/06-security/issues/` to `docs/06-security/closed/` with a Resolution section.

## Findings to remediate

<List each finding being remediated in this dispatch:>

1. **SEC-<NNN>** — <title> — severity: <🟠 / 🟡 / ⚪>
2. **SEC-<NNN>** — <title> — severity: ...

For each finding, the remediator reads the full issue file and follows the recommended remediation direction.

## CEO intent (verbatim if a direct quote)

> "<exact CEO words, if applicable>"

## Context

<2-4 sentences. Why these findings are being remediated now, in this group. E.g., "post-epic security sweep produced N findings; this dispatch closes the application-level ones, leaving the infra-level SEC-005 for DevOps.">

## Scope per finding

For each finding the remediator should:

1. Read the finding file in full
2. Identify the minimal change that closes the finding
3. Implement the change
4. Add tests that would have caught the original issue
5. Update the finding file to `closed/SEC-<NNN>.md` with a Resolution section
6. Update `docs/06-security/_MOC.md` and `docs/06-security/summary.md`

## Lane

**You may touch**:
- `apps/api/**` (for application-level findings)
- `packages/shared/**` (if a schema-level fix is needed)
- `docs/06-security/issues/` and `docs/06-security/closed/` (move and edit)
- `docs/06-security/_MOC.md` and `summary.md`
- `docs/03-decisions/**` (only if the fix establishes a security policy worth an ADR)

**You must NOT touch**:
- `apps/web/**` (unless cross-lane authorized — frontend security fixes need explicit approval)
- `infra/**` (escalate; that's DevOps lane)
- Other agents' SKILL files

## Cross-lane authorization (if applicable)

<Only fill in if a finding requires touching apps/web or infra and you've cleared it. Otherwise remove.>

For finding **SEC-<NNN>**, you are authorized to also modify:
- `<file path>` — <what change> — reason: <why>

Mark the commit message clearly.

## Concurrent work declaration

<Same as other templates>

## Decisions already made

- Soft-delete: middleware enforced (ADR-0032); fixes should not bypass it
- Pagination: deferred (ADR-0030); do not add pagination as part of a remediation
- Markdown sanitization: render-time policy (ADR-0029); backend remediation does not add sanitizers
- Other relevant decisions: <list>

## Per-finding triage discretion

If a finding turns out to be:

- **Already fixed elsewhere**: document in the closed file's Resolution as "no-op; closed by prior change <link>"
- **Out of your lane**: do NOT attempt cross-lane; flag and continue with others. Surface to CTO for redirection.
- **Larger than expected** (structural fix required): stop, escalate to CTO with a triage note. Do not improvise structure.

## Acceptance criteria

For each finding remediated:

1. The vulnerability is no longer present (verifiable by the test added)
2. Tests pass (existing + new)
3. The finding file is moved to `closed/` with a Resolution section containing:
   - What was changed (file + summary)
   - Tests added (count and brief description)
   - Verification steps
   - Residual risk (if any — be honest)
4. MOC and summary reflect the new state

## Workflow

Standard git workflow:
1. Issue: typically one issue covers a remediation batch
2. Branch: `fix/issue-<N>-remediate-<scope>`
3. File-by-file commits with `fix:` prefix for code, `docs:` for moved findings
4. Push, open PR to `dev`

**Reminder**: file-by-file may produce many commits for transversal fixes. That's expected. Do not group them with `add -A`.

## Reporting

When you finish:

1. **Summary**: which findings closed, which escalated, which deferred
2. **Per-finding outcome**:
   - SEC-<NNN>: closed (fix + test) | escalated (reason) | deferred (reason)
3. **Files changed**: list
4. **Tests added**: count and what they cover
5. **Cross-lane edits made**: if any
6. **New findings discovered during remediation**: if you noticed adjacent issues, list them (do NOT fix without dispatch)
7. **Sub-tasks pending for other agents**: e.g., "DevOps needs to verify SEC-005 fix in prod compose"
8. **Frictions**: anything that broke or surprised

Do NOT open the PR until I confirm. Wait for my OK.

## When to stop and ask

- Finding requires a structural change (queue, new service, refactor across module)
- Finding's severity seems mis-set (you'd argue for higher or lower)
- Finding is out of your lane and the dispatch didn't authorize cross-lane
- A new finding is discovered that's more severe than the ones being remediated
- The "recommended remediation" in the finding is unclear or seems wrong

Raise with 🚨.
```

---

## CTO-side fill checklist

- [ ] Specific findings are listed by ID
- [ ] Cross-lane authorization is present only if genuinely needed
- [ ] Decisions section cites the relevant ADRs
- [ ] Per-finding triage discretion is intact
- [ ] No bracketed leftover text remains