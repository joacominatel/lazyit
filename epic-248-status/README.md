# epic-248-status/ — TEMPORARY working notes (Applications Workflow Engine)

> ⚠️ **EPHEMERAL FOLDER — DELETE THIS WHOLE FOLDER (`rm -rf epic-248-status/`) BEFORE THE FINAL
> `feat/issue-247-async-workers-bullmq-valkey → dev` MERGE THAT CLOSES THE EPIC.**
> It is a working scratchpad / handoff for resuming across `/compact` and across days. It is NOT
> part of the product docs vault (`docs/`) and must never reach `dev`/`master`.

Canonical, permanent docs live elsewhere (already on `dev`): the design study in
[`docs/workflow-engine/`](../docs/workflow-engine/) (`_synthesis.md` is binding) and
[`docs/03-decisions/0054-applications-workflow-engine.md`](../docs/03-decisions/0054-applications-workflow-engine.md).
The cross-session CTO memory is `~/.claude/projects/.../memory/workflow-engine-epic.md`.

## TL;DR (where we are — 2026-06-08)
- **Goal:** a per-Application, admin-configurable engine that automates provisioning/deprovisioning in
  external systems (Jira-style) when access changes in lazyit. Opt-in; no workflow = behaves as today.
- **Substrate (ratified):** BullMQ on Valkey, **"BullMQ executes; PostgreSQL remembers."**
- **Phase 0: DONE, on `dev`.** **Phase 1: IN PROGRESS, on `feat/issue-247…`** (1a + 1b-A merged into
  the epic branch, NOT yet promoted to `dev`).
- **Next:** Phase **1b-B** (engine core: trigger/outbox + orchestrator + worker + endpoints), then
  **1c** (builder UX), then promote to `dev`. Plus the **#257** Redis-robustness fix.

## Index
- [`00-STATUS.md`](00-STATUS.md) — full state: done / branches & PRs / decisions / known issues.
- [`01-RESUME.md`](01-RESUME.md) — how to pick this up tomorrow (concrete next steps + the work pattern).
