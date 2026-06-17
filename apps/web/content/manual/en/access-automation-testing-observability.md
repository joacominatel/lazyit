---
title: Testing & observability
order: 4
category: access-automation
subcategory: testing-observability
---

# Testing and observability

You can validate a workflow before turning it on, and inspect exactly what every run did afterwards.
None of the testing tools provision anything.

## Test connection

On a connection, **Test connection** runs a single **read-only** probe to confirm lazyit can reach
the system and authenticate. It performs an authenticated request to the connection's base URL (or
to an optional **Health check path** you set, e.g. `/health`) and reports **Reachable** or **Failed**
with the HTTP status and the path it probed. It **never provisions** — it only checks connectivity.

Some connection types have nothing to probe read-only: a **Human task** makes no external call, and a
**Webhook** is write-only (a signed POST), so "Test connection" tells you there is nothing to probe
rather than sending a real event.

## Dry-run (Test run)

A **dry-run** previews the would-be requests and the path a run *would* take through the workflow,
against a **real grant** — but **nothing is sent and nothing is provisioned**. Use it to confirm your
data mapping and your success/failure edges before enabling the workflow.

- Pick a **Sample grant** (one of the application's active grants) whose context the requests resolve
  against. If there are no active grants, grant someone access first so there is something to sample.
- The result shows each step's method, target, **mapped fields**, headers and body (with secrets
  redacted), and where the run would end.
- You can **simulate a step failure** to preview that step's failure edge (escalate / compensate /
  stop) without anything actually failing.

## The run timeline

Every real run is recorded. Open a run to see its **Timeline**: each step in the order it executed,
its status, the HTTP status where applicable, the **attempt** number, and the **success/failure
edge** that was taken. From a step you can open its **Request details** (method, target host, and the
mapped field names) and jump to the **manual task** if the run paused.

> **What is recorded — and what is not.** For privacy and safety, request and response **bodies are
> not captured by design.** A run records only the method, the target host, the mapped *field names*
> (not their values), and a coarse outcome. Secrets are never recorded.

The application's Workflows tab also shows **Recent runs**, and each grant carries a small chip —
**Provisioned**, **Provisioning…**, or **Needs attention** — so you can see at a glance whether a
grant's automation completed.

## Retrying and re-running a failed run

When a run ends **Failed**, you have two recovery actions (both need the **`workflow:run`**
permission):

- **Retry** — resume the **same run**, from the step that failed, on the **version it was pinned to**.
  Use this for a transient problem (the external system was briefly down) where the workflow itself is
  correct. You can optionally **Retry with overrides** to supply a one-off value for a field on the
  failed step — the override applies to *that attempt only*, is never saved, and does not edit the
  workflow.
- **Replay with latest** — start a **brand-new run** on the **current** workflow version for the same
  grant, from the first step. Use this *after you have fixed the workflow*, because a plain Retry
  replays the old pinned version and cannot pick up your edits.

> **Replay is guarded.** If the failed run already completed a non-reversible (non-idempotent) step,
> lazyit **refuses to replay** — a fresh run would create that thing twice. In that case, re-grant the
> access instead.

## How transient failures are retried

When a step has **Retry on failure** turned on, lazyit retries only **transient** failures —
timeouts, network blips, and HTTP **5xx** responses — using your chosen attempts and backoff. An HTTP
**4xx** is a permanent error (bad request, unauthorized, not found) and is **never retried**, because
retrying it would never help; the step takes its **On failure** edge instead.
