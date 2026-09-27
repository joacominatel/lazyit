# Working in lazyit

The reasons behind the workflow. The facts are in `.claude/charter.md`; the full procedure is
in `docs/04-development/claude-workflow.md`. This file is the part that changes judgement.

## English everywhere

Code, identifiers, comments, commits, PRs, issues, and the whole `docs/` vault are in English.
The Manual ships in `en` and `es`. Conversation with the CEO is in Spanish; nothing that lands
in the repository is.

## The PR is the review surface, not the commitment

Open it. It can be closed, amended, or superseded at no cost, and CI plus the CEO's review both
gate it. Waiting for permission only parks finished work where nobody can see it.

## History is append-only

The review trail is what makes a PR reviewable at all, and rewriting it destroys the record of
what was decided and when. Bulk staging has the same problem from the other side: it sweeps in
whatever else happened to be in the tree, and the commit stops describing one thing.

That is why the history rules exist. `AGENTS.md` lists them; `guard-git.sh` enforces them.

## Ask before, not after

A wrong assumption is discovered at review time, when the work is already built on it. Anything
touching the data model, authorization, delete or migrate semantics, security, or an
irreversible action is escalated before acting. Under-asking is the more expensive failure.

## The documentation is binding

`docs/` is not commentary on the code, it is the specification the code is measured against.
That is why it wins a disagreement, and why a change that lands without its documentation
update is incomplete rather than merely untidy.

## Somebody is already running this

lazyit is live on self-hosted instances with populated databases, and operators upgrade in
place. A change that only works on a fresh install is a regression for every existing user.
That is what makes upgrade-safety a review dimension and not a preference.

## Lint is scoped, deliberately

The repository is knowingly not eslint-clean — there is a legacy backlog that CI reports and
does not gate. Only changed files block. Never run repo-wide `bun run lint`: it reformats files
outside your scope and produces a diff nobody asked for.
