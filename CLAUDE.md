@AGENTS.md

## Claude Code

- Operational facts live in `.claude/charter.md`. Read it before acting.
- Area conventions load automatically from `.claude/rules/` when you touch matching files —
  you do not need to go looking for them.
- Project skills: `lazyit-navigator` (where things live and the reasoning path) ·
  `lazyit-decisions` (the ADR index) · `lazyit-cto` · `lazyit-sentinel` (find, don't fix) ·
  `lazyit-remediator` (fix a finding) · `lazyit-devops` (infra only).
- Dispatch on the base agents — `implementer`, `reviewer`, `analyst` — and put the role, the
  lane from the charter, and the acceptance criteria in the prompt.
