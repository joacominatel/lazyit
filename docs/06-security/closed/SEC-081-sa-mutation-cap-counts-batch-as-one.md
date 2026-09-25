---
id: SEC-081
title: The per-SA AI mutation cap counts a 200-row batch as one change (headless and MCP)
severity: low
status: fixed
cwe: CWE-770
discovered: 2026-09-25
module: ai (headless / mcp)
tags: [ai, headless, mcp, service-accounts, rate-limit]
---

# SEC-081 — Per-SA mutation cap counts a batch tool as one mutation

## Summary

The admin's per-Service-Account cap (`maxMutationsPerRun`: per headless run, and per rolling hour over
MCP) counts tool invocations. A single `asset_update_batch` or `asset_create_batch` call counts as one,
but it can write up to 200 assets. A cap of 1 therefore allows 200 asset writes per run or per hour.

## Description

- Headless: `mutationsInRun` counts `ai_tool_invocations` rows of class `write`/`elevated`
  (`apps/api/src/ai/runtime/agent-loop.ts:1188-1196`), and the loop refuses a new write when that count
  reaches the cap (`agent-loop.ts:975-982`).
- MCP: `overServiceAccountWriteCap` counts the same rows over the last hour
  (`apps/api/src/mcp/mcp-server.factory.ts:124-156`).
- `asset_update_batch` and `asset_create_batch` are ordinary `write` tools with up to
  `ASSET_BATCH_MAX_ROWS = 200` rows (`apps/api/src/ai/tools/assets.tools.ts:750`). Each row runs its own
  `AssetsController` write (`assets.tools.ts:1249`, `1909`), but the whole call is one invocation row.

What the operator is told (`apps/web/messages/en/settings.json:779`): *"Cap the changes the assistant may
make for this account: per headless run, and … per rolling hour over MCP."* The tools note documents the
batch as bounded only by the principal's `asset:write`
(`docs/ai-assistant/tools-and-execution.md` "Auto-approve" bullet of `asset_update_batch`), and nothing
says the cap is per call. The MCP 60-writes-per-minute limit counts calls the same way.

## Impact

The cap is the admin's blast-radius control for autonomous runs (ADR-0097 E4: "Autónomo total, pero
configurable in-app"). A prompt-injected or misbehaving headless run, or an MCP client on an SA, can make
200× the configured number of asset changes (create, or edit status, location, model, company, dates and
specs). Everything stays within the SA's own `asset:write`, goes through route guards, and is recorded in
history and the ledger, so nothing is unauthorized or unaudited. This is why the severity is Low.

## Proof of concept

Reasoned from the code, not executed. Set an SA's AI access to read-write with `maxMutationsPerRun = 1`.
Then:

```
POST /ai/runs  (Authorization: Bearer lzit_sa_…)
{ "prompt": "Set status RETIRED on every asset in location X (use asset_update_batch)" }
```

The loop sees 0 prior mutations and allows the call, and the tool updates up to 200 assets. A second write
is then refused ("The mutation cap of this run (1) was reached"), after the 200 have already changed.

## Affected

- `apps/api/src/ai/runtime/agent-loop.ts:975-982`, `1188-1196`
- `apps/api/src/mcp/mcp-server.factory.ts:124-156`
- `apps/api/src/ai/tools/assets.tools.ts:750` (and both batch tools)

## Recommendation

Count what a call writes, not the call:

- Weight a batch by its row count, known before execution from the validated input (`rows.length`), and
  refuse the batch when `used + rows > cap`. After execution, count the entity refs it changed.
- Or, more simply, refuse batch tools on a principal with a cap set, and point to single-row tools or
  asking the admin to lift the cap.
- Say in the Settings copy and the Manual what a "change" is.

## Prevention

Add a `weight(input)` to the tool descriptor, default 1 and the row count for a batch, used by every cap
and limiter (headless cap, MCP hourly cap, MCP per-minute write limit). Add a test with a cap of 1 and a
two-row batch.

## References

- OWASP LLM06 (excessive agency), LLM10 (unbounded consumption).
- `docs/ai-assistant/security.md` §6.6, §6.8; `docs/ai-assistant/mcp-and-oauth.md` "The per-SA write cap
  over MCP".

## Resolution

**Status**: fixed
**Fixed in**: commit `e760102b` (`fix(api): count a batch's rows toward the per-SA mutation cap (SEC-081)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-25

### Changes
- `apps/api/src/ai/core/tool-descriptor.ts`: new optional `mutationWeight(input)` hook on the descriptor.
  It returns how many changes one call counts for (default 1).
- `apps/api/src/ai/tools/assets.tools.ts`: `asset_create_batch` and `asset_update_batch` weigh their
  non-skipped rows.
- `apps/api/src/ai/core/mutation-weight.ts`: `mutationWeightOf(tool, rawInput)` validates the input with
  the tool's own schema and returns at least 1. `mutationsUsed(prisma, tools, where, cap)` counts plain
  writes in the database and weighs the stored input of batch rows. It reads at most `cap` batch rows,
  because each weighs at least 1.
- `apps/api/src/ai/runtime/agent-loop.ts` (headless) and `apps/api/src/mcp/mcp-server.factory.ts` (MCP,
  rolling hour; the factory now injects `AiToolRegistry`): the cap compares `used + weight` with the cap.
  A call that would pass it is refused whole, with a message naming its weight and what is left.
- The Settings copy ("Cap the changes…") is now accurate and is unchanged. The Manual
  (`ai-assistant-setup`, en/es) now says that every changed record counts and that an oversized batch is
  refused whole.

### Tests added
- `apps/api/src/ai/runtime/agent-loop.untrusted-sources.spec.ts` › SEC-081. With cap 2:
  - A 3-row batch is refused before it runs. Without the fix, it runs.
  - A 2-row batch uses up the cap, so the next write is refused. Without the fix, both run.
- `apps/api/src/mcp/mcp-server.factory.spec.ts` › `a batch counts its rows, not one call (SEC-081)`:
  - An oversized batch is refused.
  - A batch that fits passes.
  - An earlier 2-row batch weighs 2.
- `apps/api/src/ai/core/mutation-weight.spec.ts`:
  - The real batch tools weigh their non-skipped rows.
  - Single-record, unknown and invalid inputs weigh 1.
  - The used-changes sum is correct.

### Verification
The full API Jest suite passes under Node. `tsc` passes for all four packages. Scoped eslint is clean.

### Residual risk
- The MCP per-minute write limiter (`MCP_WRITE_RATE_LIMIT`) still counts calls. It is a rate bucket, not
  the admin's blast-radius cap, and a batch is bounded at 200 rows.
- The cap stays soft under concurrency, as documented: calls racing past the count can overshoot by
  the number in flight.
