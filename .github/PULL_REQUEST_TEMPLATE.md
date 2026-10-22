<!--
Target branch: dev (never master directly). See docs/05-runbooks/git-workflow.md.
Keep this short and human. Delete sections that don't apply.
-->

Closes #<!-- issue number -->

## What changed

A short prose summary — what this does and why, not a file-by-file list.

## How to verify

Concrete steps a reviewer can run: a `curl`, a smoke test, a screen to open.

## Docs / ADRs

Docs updated, or new ADRs (if any). Write "n/a" if the change needs none.

## Notes for the reviewer

Anything worth flagging — trade-offs, follow-ups, an `auto-generated` sub-issue you opened.

<!--
Note: this PR targets `dev`, so GitHub ignores `Closes #N` here on the dev-merge. The
promotion-autoclose workflow reads it from this body and closes the issue when `dev` is
promoted to `master` — one keyword per issue; use `Refs #N` when the PR does not finish it.
A closed issue means the work is in production. See the runbook's "Issue auto-close" section.
-->
