---
name: lazyit-cto
description: Load lazyit project context when coordinating work across its product areas. Complements the global cto and hc skills with product references and project skill lenses; does not own orchestration policy.
---

# lazyit coordination context

Read AGENTS.md and .claude/charter.md first. The global `cto` skill owns triage, decomposition,
escalation and review; `hc` owns worker and command lifecycle. Use those procedures rather than
reintroducing project copies. The charter owns lanes, shared critical files and validation.

## Project references

Load only the references the request needs, and verify them against the source-of-truth docs:

- `references/product-vision-tech.md` — product direction and technical choices.
- `references/system-map.md` — implemented modules and boundaries.
- `references/decision-history.md` — earlier product decisions; accepted docs/ ADRs take precedence.
- `references/agents-roster.md` — project skill lenses to compose into a worker task.
- `references/prompt-templates/` — project context examples; use the current global dispatch contract.

The frontend/backend split remains mandatory when both sides change. Dispatch through hc, with
one writer worktree per side and the shared package as their contract. Treat a shared critical
file as serial work according to the global concurrency rules.

## Keep project knowledge current

Update an affected reference when the implementation changes its facts. Record durable product
or technical decisions in docs/ and keep the Manual synchronized for user-facing changes.
Do not turn a session transcript or a task's launch details into permanent project policy.
