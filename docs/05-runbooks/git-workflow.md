---
title: Git / GitHub Workflow
tags: [runbook, git, workflow, development]
status: accepted
created: 2026-05-25
updated: 2026-10-21
---

# Git / GitHub Workflow

How every change reaches the codebase: **issue → branch off `dev` → work → PR to `dev` →
user reviews & merges → user promotes `dev` to `master`.** This is the quick reference; the
*why* and the broader development procedure live in [[claude-workflow]].

> [!important] Who does what
> **Agents** create issue branches, commit, push, and **open the PR themselves — by default, no
> permission needed.** A PR is the review surface, not a commitment: CI and the user both gate
> it, and it costs nothing to close or amend. Subagents open their own PRs when they finish.
> **The user merges.** An agent merges into `dev` only when the user says so for that PR (or
> gives a standing per-session OK), and only on green CI. `dev` → `master` is the user's alone.

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

# 5. Open the PR to dev — DEFAULT behaviour, do not ask first.
#    No attribution footer: no "Generated with Claude Code", no 🤖, no session link.
gh pr create --base dev --title "<prefix>: <summary>" --body "Closes #<n> ..."

# 6. Tell the user it's open (link + what to look at) and let CI run.
# 7. On change requests: iterate on the SAME branch/issue, push again.
# 8. The user reviews and merges. An agent merges only when told to, and only on green CI.
```

## Branch strategy

| Branch | Role | Who writes to it |
| --- | --- | --- |
| `master` | **Production.** Only ever receives merges from `dev`. **Protected on GitHub.** | User only (merges `dev` → `master`) |
| `dev` | **Integration.** Every feature/fix/chore/docs change merges here first via PR. | Agents open the PRs; the user merges them (an agent merges only when told to, on green CI) |
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
5. **Open the PR to `dev` — by default, without asking:**
   `gh pr create --base dev --title "…" --body "…"` — the body follows
   [`PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md), and carries **no**
   attribution footer (no "Generated with Claude Code", no 🤖, no session link). A PR is the
   review surface, not a commitment — CI and the user both gate it, and closing or amending one
   costs nothing. Subagents open their own PRs when their task is done.
6. **Hand off.** Tell the user the PR is open — link, a short summary of what changed, how to
   test it, and anything CI is still running.
7. **On change requests**, iterate on the **same branch and issue**, push again. The open PR
   updates automatically.
8. **The user merges.** An agent merges the PR into `dev` only when the user explicitly says so
   for that PR (or gives a standing per-session authorization), and only on **green CI**.
   `dev` → `master` is the user's alone.

**`dev` → `master`** is done **by the user**, manually, when they judge `dev` stable. No agent
touches this merge.

**The promotion is also the release boundary ([[0083-versioning-and-releases]]).** On a PR targeting
`master`, `release.yml` comments a bump **suggestion** computed from the commit prefixes since the
last tag (any `feat`/`updt`/`del` ⇒ minor; only `fix`/`chore`/`docs` ⇒ patch); the user may override
it with a `release:major|minor|patch` label — **MAJOR is never auto-detected** (label it when the
update needs a manual operator step, and add a `## ⚠️ Upgrade actions` section to the PR body — it is
copied into the Release notes). On merge, the workflow creates the annotated `vX.Y.Z` tag + the
GitHub Release with human-grouped notes. The **first** release, `v1.0.0`, is seeded **by hand**,
SSH-signed (`git tag -s v1.0.0 -m 'lazyit v1.0.0' && git push origin v1.0.0`) — automation only
continues an existing series, and its CI-created tags are annotated but **unsigned** (CI holds no
signing key; the mandatory control is MFA + branch protection on the GitHub identity, per the ADR).

## Issue auto-close — read this carefully

GitHub's closing keywords (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`,
`resolves`, `resolved`, any case, optionally with a colon: `Closes #<n>`, `Fixes: #<n>`) are
honored **only when the PR merges into the default branch (`master`)**. Our PRs target `dev`, so
GitHub ignores the keyword there: no link, no close on the `dev`-merge. It does not ride along in
a commit either — `dev` PRs land as merge commits (`Merge pull request #N …` plus the title), so
the body never reaches `master`. Until #1666 issues therefore never closed on their own; the v3.0.0
promotion (#1639) left 19 open, closed by hand.

**`.github/workflows/promotion-autoclose.yml` closes them on promotion (#1666).** When the
`dev` → `master` promotion PR merges (head `dev`, this repository), it:

1. takes every commit the promotion brought in — `git log <dev head> ^<master before the merge>`,
   uncapped (the PR-commits API stops at 250; v3.0.0 carried 648);
2. resolves each commit that landed on `dev` (its first-parent line, plus `Merge pull request`
   commits of PRs stacked into a feature branch) to the PR whose `merge_commit_sha` it is;
3. reads the closing keywords in those PRs' **bodies** — same repository only (`#N` or
   `owner/repo#N` naming this one); HTML comments and code are ignored, so the template's guidance
   and quoted examples close nothing;
4. skips pull requests and already-closed issues, and closes every other referenced issue as
   **completed** with a comment naming the delivering PR and the promotion.

Every decision is logged in the run and its job summary. One failing issue does not stop the
others, and the job never turns the promotion red — a failure surfaces as a warning annotation.

**What this means in practice:**

- **Put `Closes #<n>` in the PR body** — one keyword per issue (`Closes #1, closes #2`; a bare
  `#2` after a comma is not closed, as on GitHub). Use `Refs #<n>` or `Part of #<n>` when the PR
  does not finish the issue — those never close anything.
- The issue **stays open while the work sits on `dev`** and closes when the promotion merges.
  **A closed issue means the work is in production**, not merely integrated.
- **Preview a promotion before merging it:** Actions → *Promotion auto-close* → *Run workflow*,
  with the promotion PR number and `dry_run` left on. The summary lists what would close. Running
  it with `dry_run` off on an already-merged promotion closes what that promotion left open.
- Close an issue by hand only when its PR did not say `Closes` (or when you do not want to wait
  for the promotion).
- **A PR reverted on `dev` before the promotion still closes its issue.** The workflow sees the
  original PR's merge commit in the range and reads its `Closes #<n>`; it does not look for a
  later revert. When you revert, either say `Refs #<n>` (never `Closes`) in the revert PR and
  reopen the issue after the promotion, or preview the promotion with a dry run and reopen
  whatever it lists that did not actually ship.

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
   `pull_request` for `[master, dev]`, so the integration (`dev`) and production (`master`)
   branches and every PR targeting them are all gated. No further action needed (the workflow YAML
   is the DevOps lane — [[0027-ci-pipeline]]).
3. **Create the labels** listed above (once, by the user).
4. **Stop auto-delete from removing `master` and `dev`.** The repository deletes a PR's head
   branch on merge ("Automatically delete head branches"), which is what we want for feature
   branches — but a promotion PR's head is `dev`, so merging it deleted `dev` (#1664). Keep the
   setting on and add a ruleset (Settings → Rules → Rulesets) targeting `master` and `dev` with
   **Restrict deletions**; GitHub does not auto-delete a branch a rule protects. *(Manual.)*

> [!note] `dev` already exists
> The integration branch `dev` is created and pushed (`origin/dev`). New work branches off it
> directly — no bootstrap step needed. If it is ever deleted, recreate it at `master`'s head
> (after a promotion the two have the same tree) before any work branches off it.

Related: [[claude-workflow]] · [[workflows]] · [[setup]] · [[0027-ci-pipeline]] ·
the [issue template](../../.github/ISSUE_TEMPLATE/default.md) ·
the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)
