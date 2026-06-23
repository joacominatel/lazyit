---
title: Git / GitHub Workflow
tags: [runbook, git, workflow, development]
status: accepted
created: 2026-05-25
updated: 2026-06-23
---

# Git / GitHub Workflow

How every change reaches the codebase: **issue → branch off `dev` → work → PR to `dev` →
user reviews & merges → user promotes `dev` to `master`.** This is the quick reference; the
*why* and the broader development procedure live in [[claude-workflow]].

> [!important] Who does what
> **Agents** create issue branches, commit, push, and (after the user's OK) open the PR.
> **Agents never merge.** The **user** reviews and merges PRs into `dev`, and is the only one
> who merges `dev` into `master`.

## TL;DR — the loop for any task

```sh
# 1. Find or create the issue (see "Issues" below)
gh issue list --search "<keywords>"

# 2. Branch off an up-to-date dev
git fetch origin && git switch dev && git pull && git switch -c <prefix>/issue-<n>-<slug>

# 3. Work: file-by-file commits with the usual prefixes
git add <file> && git commit -m "feat: <what changed>"

# 4. Push (first time sets upstream)
git push -u origin <prefix>/issue-<n>-<slug>      # then just: git push

# 5. Tell the user you're done — DO NOT open the PR yet. Wait for them to test.

# 6. On the user's OK, open the PR to dev:
gh pr create --base dev --title "<prefix>: <summary>" --body "Closes #<n> ..."

# 7. On change requests: iterate on the SAME branch/issue, push again.
# 8. The user reviews, approves and merges on GitHub. Agents never merge.
```

## Branch strategy

| Branch | Role | Who writes to it |
| --- | --- | --- |
| `master` | **Production.** Only ever receives merges from `dev`. **Protected on GitHub.** | User only (merges `dev` → `master`) |
| `dev` | **Integration.** Every feature/fix/chore/docs change merges here first via PR. | User merges PRs here; agents never merge |
| `stage` | **Permanent staging / CI environment branch** — an intentional, long-lived env branch in the `dev` → … → `master` flow. CI gates it exactly like `master` and `dev` (push + PR). | User only |
| `<prefix>/issue-<n>-<slug>` | **One branch per concrete piece of work**, always cut from `dev`. | The agent doing that work |

- All issue branches are cut **from `dev`**, never from `master`.
- Conflicts are resolved **at PR merge time on GitHub**, not during development. Because each
  agent works on its own branch, parallel work no longer collides on a shared branch.

## Branch naming — aligned with commit prefixes

`<prefix>/issue-<n>-<slug>` — the prefix is the same set used for commit messages, so the
branch announces the kind of change.

| Prefix | For |
| --- | --- |
| `feat/` | new functionality |
| `fix/` | bug fix |
| `chore/` | maintenance, configuration |
| `del/` | removing code / a feature |
| `updt/` | updating a dependency or something existing |
| `docs/` | documentation only |

The `<slug>` is short and descriptive: **kebab-case, ≤ 5–6 words, in English.**

```
feat/issue-42-add-accesses-screen
fix/issue-58-soft-delete-bypass-on-articles
docs/issue-72-update-deployment-runbook
```

## Issues — the hybrid model

- **The user creates the principal issues** — large features, new ADRs, product decisions.
- **Agents may create technical sub-issues** they discover mid-task (a refactor that surfaced,
  detected debt, sub-tasks). These **must** carry the `auto-generated` label so the user can
  filter and review them.

**First step of any task — check for an existing issue:**

```sh
gh issue list --search "<keywords>"          # search open issues by keyword
gh issue view <n>                            # read one
```

- **Issue exists** → work against that number.
- **No issue, scope is clear** → create it yourself:

  ```sh
  gh issue create --title "<clear title>" --body "<context + success criteria>" \
    --label auto-generated
  ```

- **No issue, scope unclear** → 🚨 **escalate to the user.** Don't guess the scope of work.

## Step-by-step workflow for agents

1. **Verify the issue.** `gh issue list --search "<keywords>"`. Reuse if it exists; create
   (with `auto-generated`) if the scope is clear; **🚨 escalate** if it isn't.
2. **Branch from `dev`:**
   `git fetch origin && git switch dev && git pull && git switch -c <prefix>/issue-<n>-<slug>`.
3. **Work on the branch.** File-by-file commits with the usual prefixes (`feat:`, `fix:`, …).
   The anti-clobber git rules below still apply.
4. **Push regularly.** `git push -u origin <branch>` the first time, then `git push`.
5. **Hand off — do NOT open the PR.** Tell the user the work is done, with a short summary of
   what changed and how to test it. Wait for them to try it.
6. **On the user's OK, open the PR to `dev`:**
   `gh pr create --base dev --title "…" --body "…"` — the body follows
   [`PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md).
7. **On change requests**, iterate on the **same branch and issue**, push again. The open PR
   updates automatically.
8. **Never merge.** Once the PR is open, the user reviews, approves and merges it on GitHub.
   The agent closes its session or moves to the next task.

**`dev` → `master`** is done **by the user**, manually, when they judge `dev` stable. No agent
touches this merge.

## Issue auto-close — read this carefully

GitHub's closing keywords (`Closes #<n>`, `Fixes #<n>`) **only take effect when the reference
reaches the default branch (`master`)**, and there is a subtlety because our PRs target `dev`:

- A closing keyword in a **PR body** is honored **only if the PR targets the default branch**.
  Our PRs target `dev`, so a `Closes #<n>` in the PR body is **ignored** by GitHub there — it
  neither links the issue nor auto-closes it on the `dev`-merge.
- A closing keyword in a **commit message** closes the issue **when that commit lands on
  `master`** (it won't list the PR as "linked", but it does close the issue).

**What this means in practice:**

- Keep `Closes #<n>` in the PR body anyway — it documents intent for the reviewer, and a
  **squash merge into `dev` carries the PR description into the squash commit message**, so the
  keyword rides along in a commit.
- The issue **does not close when the PR merges into `dev`.** It closes when the change is
  **promoted to `master`** (the user's `dev` → `master` merge brings the keyword-bearing commit
  onto the default branch). This is intentional: **a closed issue means the work is in
  production**, not merely integrated.
- If a squash message strips the keyword, or you don't want to wait for promotion, **close the
  issue manually**.

## Labels (set the user creates in GitHub)

Agents don't create labels — the user creates them once via the GitHub UI or `gh label create`.
This is the minimum set the workflow assumes:

**Area** — `area:backend` · `area:frontend` · `area:infra` · `area:security` · `area:docs`
**Type** — `type:feat` · `type:fix` · `type:chore` · `type:docs`
**Priority** — `priority:critical` · `priority:high` · `priority:normal` · `priority:low`
**State** — `auto-generated` (issues opened by agents) · `blocked` (waiting on something else)
· `needs-decision` (escalated to the user)

Create them like so (run once by the user):

```sh
gh label create "area:backend"   --color 1f6feb
gh label create "auto-generated" --color a371f7 --description "Opened by an agent — review me"
# …one per label above
```

## Git rules that still apply (anti-clobber)

These hold **inside your issue branch** exactly as before. Per-branch isolation lowers the
collision risk, but the discipline is unchanged — and `amend`/`rebase`/`reset` still rewrite
history, which breaks the PR's review trail.

- ❌ Never `git commit --amend`, `git rebase`, or `git reset`.
- ❌ Never `git add -A` / `git add .` — stage explicit files only.
- ✅ `git add <file>` then `git commit`. Commits are **file-by-file** (docs may be grouped).
- Message prefixes: `feat` · `fix` · `chore` · `del` · `updt` · `docs`. No `Co-Authored-By` /
  Claude attribution trailers.

## Pending setup actions (user / DevOps)

These live outside an agent's documentation lane and must be done once for the workflow to be
fully enforced:

1. **Protect `master` on GitHub** — require PRs, block direct pushes and force-pushes. The user
   configures this in repo Settings → Branches. *(Manual; not scripted here.)*
2. **CI gates `dev` — ✅ DONE.** `.github/workflows/ci.yml` triggers on `push` **and**
   `pull_request` for `[master, dev, stage]`, so the integration (`dev`), staging (`stage`) and
   production (`master`) branches and every PR targeting them are all gated. No further action
   needed (the workflow YAML is the DevOps lane — [[0027-ci-pipeline]]).
3. **Create the labels** listed above (once, by the user).

> [!note] `dev` already exists
> The integration branch `dev` is created and pushed (`origin/dev`). New work branches off it
> directly — no bootstrap step needed.

Related: [[claude-workflow]] · [[workflows]] · [[setup]] · [[0027-ci-pipeline]] ·
the [issue template](../../.github/ISSUE_TEMPLATE/default.md) ·
the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)
