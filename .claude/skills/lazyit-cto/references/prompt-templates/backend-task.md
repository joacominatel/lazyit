# Backend Task Template

> Template for dispatching a backend feature, refactor, fix, or doc-adjacent task. The agent loads the `lazyit-navigator` skill.
>
> **How to use**: copy this template, replace every `<bracketed>` slot with concrete content, remove any optional sections that don't apply, send to the agent. Do not leave bracketed text in the dispatched prompt.
>
> **Tone**: direct, declarative, no apologetic preamble. The agent is a competent engineer, not a junior who needs handholding — but it does need context.

---

```markdown
# <Task title in 5-10 words>

## Objective

<One line. What this task accomplishes when complete.>

## Context

<2-4 sentences. What in the system motivates this task. Reference relevant ADRs, entity notes, or runbooks by path. Do not paraphrase ADRs — link them.>

Relevant references:
- `docs/03-decisions/NNNN-<adr-name>.md` — <one-line reason it matters here>
- `docs/02-domain/<entity>.md` — <one-line reason it matters here>
- <optional: previous PR or issue that this builds on, by number>

## CEO intent (verbatim if a direct quote)

<If this task originated from a specific CEO instruction, quote it. This ensures the agent sees the original intent without my interpretation.>

> "<exact CEO words, if applicable>"

## Scope

**In scope**:
- <Concrete bullet 1>
- <Concrete bullet 2>
- <...>

**Explicitly out of scope** (do NOT touch in this PR):
- <Anything tempting that should wait>
- <Cross-lane work that another agent will handle>

## Lane

**You may touch**:
- `apps/api/**` (or specific subpaths)
- `packages/shared/**` (if schema changes are needed)
- `docs/02-domain/**` (entity notes)
- `docs/03-decisions/**` (new ADRs for backend decisions)

**You must NOT touch**:
- `apps/web/**`
- `infra/**`
- `.github/**`
- Other agents' SKILL files
- <Optional: specific files that another agent is currently working on; list them>

## Concurrent work declaration

<If another agent is working in parallel right now, declare it. Otherwise: "No concurrent work; you have exclusive access to the lane.">

- <Agent X is working on branch Y, touching <files>. Avoid those files.>

## Decisions already made (do not re-litigate)

- <Decision 1>: <one-line outcome>. Per `<ADR or reference>`.
- <Decision 2>: ...
- <Add as many as needed; aim for completeness, not brevity>

## Approach hints (optional)

<Use this section sparingly. If you have a strong opinion about how to approach something, state it. If you don't, leave the section out. Don't micromanage.>

## Acceptance criteria

<Concrete and verifiable. The agent uses this to know it's done.>

1. <Criterion 1 — observable behavior>
2. <Criterion 2 — tests pass>
3. <Criterion 3 — docs updated>
4. <...>

## Tests required

<Be specific about what level of test:>

- Unit tests for: <service / function>
- Integration tests for: <controller endpoint, if applicable>
- Manual smoke test instructions: <curl command, if applicable>

## Documentation required

- ADR: <yes/no — if yes, suggested number and title>
- Entity note update: <yes/no — which file>
- Runbook update: <yes/no — which runbook>

## Workflow

Standard git workflow applies:
1. Create or claim issue (it may already exist as #<N>; verify with `gh issue list`)
2. Branch from `dev`: `feat/issue-<N>-<slug>` (or `fix/`, `chore/`, etc.)
3. Commit file-by-file with appropriate prefixes
4. Push and open PR to `dev` with `Closes #<N>` in body
5. Pause and report; do not merge

**Rules**:
- No `git --amend`, `rebase`, `reset`, `add -A`, or `add .`
- Scoped lint only (your files), never `bun run lint` repo-wide
- File-by-file commits; docs may be grouped

## Reporting

When you finish (or when blocked):

1. **Summary**: what you delivered in 3-5 lines
2. **Files changed**: list with one-line each
3. **Tests added**: counts before / after, suite breakdown
4. **Smoke verification**: actual command(s) you ran and output
5. **ADRs created or updated**: list
6. **Debt or follow-ups**: anything you noticed but did not fix (with reasoning)
7. **Frictions**: anything that slowed you down or broke convention

Do NOT open the PR until I confirm your report. Wait for my OK.

## When to stop and ask

- Any scope decision not covered above
- Any architectural choice not in the references
- Any conflict with an existing ADR
- Any failed test you cannot diagnose
- Any required dependency not already in `package.json`

Raise the question with 🚨 in your message so I can route it.
```

---

## CTO-side fill checklist

Before sending, the CTO verifies:

- [ ] Objective is one line, declarative
- [ ] Every bracketed `<...>` has been replaced with concrete content
- [ ] Lane is explicit (in + out)
- [ ] Concurrent work declaration is current (if there's parallelism)
- [ ] Decisions cited link to actual ADRs or references
- [ ] Acceptance criteria are observable, not vague
- [ ] Workflow section is intact (do not edit the git rules)
- [ ] Reporting section is intact
- [ ] No bracketed leftover text remains