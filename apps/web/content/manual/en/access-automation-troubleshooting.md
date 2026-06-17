---
title: Troubleshooting
order: 6
category: access-automation
subcategory: troubleshooting
---

# Troubleshooting Access Automation

When automation does not do what you expect, the run timeline almost always tells you why. Start
there: open the application's **Workflows** tab, find the run (or look at the grant's chip —
**Needs attention** means a run failed), and read its [timeline](/help/access-automation-testing-observability).

> Whatever goes wrong with a workflow, **the access grant is safe.** A failed run never rolls back or
> blocks the grant — it just means the external system wasn't updated yet.

## A grant didn't trigger any automation

If granting or revoking access produced no run at all, check, in order:

- **Is a workflow enabled?** An application with no enabled workflow records the grant and does
  nothing else — that is the normal opt-in default. Enable the workflow from the workflow list.
- **Does the trigger match?** A workflow set to *Access granted* will not fire on a revoke (and vice
  versa). Confirm the workflow's trigger.
- **Does the workflow have steps?** A workflow with no authored steps has nothing to run, so no run
  is created.
- **Is it the right application?** Workflows are per application; the grant must be for the
  application that owns the workflow.

## A step failed with a 4xx (400 / 401 / 403 / 404)

A **4xx** is a *permanent* error and is **never retried** — retrying would not help. It usually means
the request itself is wrong:

- **401 / 403** — the credential is missing, wrong, or lacks permission in the external system. Add
  or **Replace** the credential on the connection, then **Test connection**.
- **400 / 422** — the payload is malformed or missing a required field. Check the step's **Data
  mapping**; run a **dry-run** to preview the exact request.
- **404** — the path is wrong, or it references an id that doesn't exist (common on revoke steps that
  target an account that was never created). Check the step's **Path**.

Fix the workflow, then use **Replay with latest** to run a fresh attempt on your corrected version.
(A plain **Retry** replays the old version and won't pick up your edits.)

## A step failed with a 5xx, timeout, or network error

These are **transient** — the external system was briefly unavailable. If the step has **Retry on
failure** enabled, lazyit retries it automatically with backoff. If it exhausted its attempts, fix or
wait for the external system, then **Retry** the failed run to resume the same run from the failed
step.

## A run is stuck "Waiting (manual)"

The run paused for a person — either a **Human task** step or an **Escalated failure**. It will stay
paused until someone acts. Open the **manual-task inbox** (Settings → Integrations), complete the
task (**Submit**, **Skip step**, or **Fail run**), and the run resumes. If you cannot act on it,
confirm you have **`workflow:task`** and are an allowed assignee — see
[Manual tasks](/help/access-automation-manual-tasks) and
[Permissions](/help/access-automation-permissions).

## "Replay with latest" was refused

If replay is refused because the run already provisioned a non-reversible step, a fresh run would
create that thing a second time. Don't force it — **re-grant the access** instead, which starts a
clean new run from the beginning.

## A credential isn't working and you can't see its value

That is by design: credentials are **write-only** — entered once, stored encrypted, and never shown
again. You cannot view a stored value to check it; if you suspect it is wrong, **Replace** it with a
known-good value and **Test connection**.

## Nothing seems to run, and even retries don't start

Automation runs on a background worker. If runs stay **Queued** and never progress, the background
queue service (Valkey) may be down — see your deployment's
[services](/help/deployment-operations-services) and
[troubleshooting](/help/deployment-operations-troubleshooting). The grants themselves are unaffected;
queued runs resume once the worker is healthy.
