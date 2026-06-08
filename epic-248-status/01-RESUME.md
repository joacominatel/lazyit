# RESUME — picking up epic #248 tomorrow

_Temporary — see [README](README.md). Read [`00-STATUS.md`](00-STATUS.md) first for the full state._

## Branch / repo state (2026-06-08)
- **Working branch:** `feat/issue-247-async-workers-bullmq-valkey` (the epic branch). HEAD ≈ `4b8b848`
  (Phase 1a + 1b-A merged in). It is **ahead of `dev`** by Phase 1a + 1b-A (those are NOT on `dev`
  yet — deliberately accumulating on the epic branch; only Phase 0 is on `dev`).
- `dev` has Phase 0 (PRs #252, #255) + the design docs.
- **Open issues:** #248 (this epic), #247 (async-workers, mostly done), **#257** (the Redis bug).
- All sub-PRs to date merged + branches/worktrees cleaned. Working tree should be clean after the push
  that created this folder.

## The work pattern (what's been working — keep it)
1. Stay on the epic branch `feat/issue-247…`. Each unit of work = a **worktree agent → PR to the epic
   branch** (the **ideal agent per lane**: devops / security / backend / frontend).
2. CTO **reviews each PR** (diffs + the agent's local verification), resolves any small conflict,
   **merges into the epic branch** (`gh pr merge --merge --delete-branch`), then `git fetch && git
   merge --ff-only` to sync local. Clean the leftover worktree (`git worktree remove --force …`).
3. **No CI runs on PRs to the epic branch** — the real gate is the epic-branch → `dev` PR (full CI).
4. **Promote to `dev`** in coherent slices: open `feat/issue-247… → dev`, watch CI
   (`gh pr checks <n> --watch` in background), **CTO-merge on green** (delegated 2026-06-08).
5. Escalate to the CEO **only** for logic/app-vision decisions.

## Concrete next steps (in order)
1. **#257 fix** (task #18) — quick, disjoint lane (`queue.module.ts` + `articles/import` + DevOps env
   contract). Can run in parallel with 1b-B. Good warm-up.
2. **1b-B — engine core.** Single backend agent (it imports 1b-A's `StepHandler` contract — see
   `apps/api/src/workflow-engine/index.ts` and the contract summary in `00-STATUS.md`/the agent report).
   Build: `WorkflowEngineModule` (imports `WorkflowConnectorsModule`); the AccessGrant **outbox
   trigger** wired into `apps/api/src/access-grants/access-grants.service.ts` (`create`/`revoke`/
   `batchRevoke`) — PENDING `WorkflowRun` in the grant tx + after-commit enqueue + a sweeper; the run
   **orchestrator/state machine**; the **BullMQ worker** (reuse the P0.1 `QueueModule`; a new
   `workflow-run` queue) that executes steps via `ConnectorRegistry`, pauses on MANUAL
   (`AWAITING_INPUT` + `ManualTask`) and resumes on completion; `LAST_ACTIVE_GRANT` enforcement on
   revoke; auto-provision the dedicated engine ServiceAccount; the HTTP endpoints (workflows /
   connections / secrets [write-only] CRUD + run status + manual-task list/complete) gated `workflow:*`;
   Jest. Wire `ctx.revealSecret = () => SecretService.revealById(connection.secretId)`.
3. **1c — builder UX** — parallelizable once 1b-B's API contract is fixed. Frontend agent.
4. **Promote** the backend slice to `dev`; continue.

## Watch-outs
- **`@lazyit/shared` permission/enum changes can break the web's exhaustive maps** — always run web
  `tsc` + the golden parity tests before merging (memory: `shared-changes-need-web-typecheck`).
- The Workflow/Agent **worktree** is sometimes based on an ancestor of the epic branch, not its tip —
  harmless here because lanes are file-disjoint and PR diffs stay clean, but verify the PR diff is only
  the intended files.
- **`WORKFLOW_SECRET_KEY`** must be set for the engine (fails loud at boot); it's a backup linchpin.
- Run the dev DB (`bun run db:up`) before any `prisma migrate` in an agent worktree.
- **Delete this folder** before the final epic → `dev` merge.
