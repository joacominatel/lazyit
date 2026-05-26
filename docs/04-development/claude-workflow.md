---
title: Working with Claude Code — Development Workflow
tags: [development]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Working with Claude Code — Development Workflow

How development happens on lazyit. This is the **default operating procedure for every
change** — human or AI. It is important enough to also live (condensed) in the root
`CLAUDE.md`.

## 1. Context before code

Before writing or changing **anything**:

- **Investigate the codebase** for whatever was asked — the relevant files, modules, and how
  they currently work.
- **Search `docs/`** for related material: the affected [[entities/_MOC|entity]], the
  [[02-domain/_MOC|domain]] rules, relevant [[03-decisions/_MOC|ADRs]], and
  [[conventions]] / [[code-conventions]].
- Fully **contextualize the change** before touching code. No edits from a cold start.

## 2. Ask, don't assume

- If a decision is required and there is **no clear reference** to follow, **ask the user** —
  for everything. A wrong assumption is more expensive than a question.
- Anything that **could be critical** (data model, auth, deletion/migration semantics,
  security, irreversible actions) → **consult the user before acting**.

## 3. Front and back via separate subagents

When a task spans **both frontend and backend**:

- Delegate to **separate subagents**: one owns the **frontend**, one owns the **backend**.
- **Claude Code orchestrates** — it specifies the tasks, contracts and acceptance criteria
  for each subagent; it does **not** implement both sides itself.
- The shared contract between them lives in [[shared-package]] (zod schemas / types).

## 4. Branches, commits & pull requests

Every change flows through GitHub: **issue → branch off `dev` → PR to `dev` → the user reviews
and merges → the user promotes `dev` to `master`.** The step-by-step with real commands is the
[[git-workflow]] runbook; this is the *why*.

- **`master` is production, `dev` is integration.** `master` is protected and only ever
  receives merges from `dev`; the **user** does that promotion. Every feature/fix/docs change
  lands on `dev` first, via PR. This keeps `master` always-releasable and gives `dev` a place to
  stabilize.
- **One issue, one branch.** Start by finding the issue (`gh issue list --search …`); reuse it,
  or open one if the scope is clear (agent-opened issues carry the `auto-generated` label), or
  **ask the user** if it isn't. Cut the branch **from `dev`**, named `<prefix>/issue-<n>-<slug>`
  — the prefix matches the commit prefix, so the branch announces the kind of change. Working on
  separate branches means parallel work no longer collides; conflicts are resolved at merge time.
- **One file per commit** — small, well-defined, reviewable. (Documentation is the exception:
  doc changes may be grouped.) **Message prefixes:** `feat` · `fix` · `chore` · `del` · `updt` ·
  `docs`. Example: `feat: add Asset model to prisma schema` · `updt: refine AssetAssignment
  rules` · `del: remove HealthCheck model` · `docs: document shared package contract`.
- **Agents hand off; they never merge.** Push the branch, tell the user it's done with a summary
  and how to test, and **wait**. Only on their OK open the PR (`gh pr create --base dev`). The
  user reviews, approves and merges. Iterate on the same branch if changes are requested.
- **History stays append-only.** No `--amend` / `rebase` / `reset` (they rewrite the PR's review
  trail), no `git add -A` / `add .` — stage explicit files. No `Co-Authored-By` / Claude
  attribution trailers.

## 5. Docs stay in sync

- Any change that **modifies/adds/removes** code — **especially core logic** — requires
  **reviewing `docs/`** for what it affects.
- If the change lands, **update `docs/` as part of the same change** (entity notes, ADRs,
  conventions, diagrams).
- **Before committing**, verify the docs don't reference **removed files** or a **changed
  philosophy**. Stale docs are a bug.

## 6. External libraries → latest docs

- When using or upgrading an **external library**, check its **latest official
  documentation** (e.g. Context7 or the web) — don't rely on memory. Versions here are recent
  (Next 16, Nest 11, Prisma 7, Tailwind 4) and APIs move.

## Definition of done

A change is done when: code is in place, **tests** exist per [[0012-testing-strategy]] (unit
always; core/complex logic thoroughly), `docs/` is updated and consistent, and commits are
file-scoped with a correct prefix.

Related: [[git-workflow]] · [[workflows]] · [[code-conventions]] · [[0012-testing-strategy]] · [[shared-package]]
