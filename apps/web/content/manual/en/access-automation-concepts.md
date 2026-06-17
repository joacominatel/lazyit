---
title: Concepts
order: 1
category: access-automation
subcategory: concepts
---

# Access Automation — concepts

Access Automation lets lazyit **act in another system** when you grant or revoke application access.
When you grant someone access to an application, a workflow can create their account in the external
tool; when you revoke it, a workflow can deactivate that account. lazyit calls these **workflows**,
and you configure them per application from the application's **Workflows** tab.

It is **strictly opt-in.** An application with no enabled workflow behaves exactly as it always has:
granting access just records the grant, and nothing is provisioned automatically. You only get
automation on the applications you deliberately set it up for.

## What a workflow is

A workflow is bound to one application and one **trigger** — the event that fires it:

- **Access granted** — runs when someone is granted access to the application.
- **Access revoked** — runs when their access is revoked.

When a workflow fires, lazyit starts a **run**: an ordered sequence of **steps** that call the
external system (or pause for a person to act). Each run is recorded so you can see exactly what
happened, step by step. Other triggers (timers, scheduling, recertification) appear in the product
but are reserved for later — today the two access triggers above are what you build against.

## The grant is the source of truth — automation is downstream

This is the most important principle to understand. **The access grant inside lazyit is the
permanent record.** External provisioning is a separate, after-the-fact effect:

- A workflow run starts **after** the grant (or revoke) is already saved. The grant is never held
  waiting on an external system.
- If the external call fails, **the grant is never rolled back, blocked, or undone.** The grant
  stands; the failed run is surfaced as something for you to fix (see
  [Troubleshooting](/help/access-automation-troubleshooting)).

In short: lazyit records who has access, and *then* tries to make the outside world match. A broken
connector means an account wasn't created yet — not that lazyit lost track of the access.

## Each grant event runs once

When a grant fires a workflow, lazyit creates **one run for that event**. If a step fails and you
retry it, the retry happens *inside the same run* — it does not create a second run, and it will not
provision the same person twice. This is why automation is safe to leave on: a transient outage
leads to a retry, not a duplicate account.

## What it is not

Access Automation is **application-access provisioning** — nothing more. It is not an HR or
onboarding system, not an identity-governance or access-review subsystem, and not a general workflow
builder for arbitrary business logic. The data a workflow can send outward is limited to the
grantee's basic details (email, first and last name, id), the application, and the grant context.
There are no role, team, or manager fields to map — by design.

## Where to go next

- [Building a workflow](/help/access-automation-building-a-workflow) — the builder, connections, and
  step types.
- [Manual tasks](/help/access-automation-manual-tasks) — steps that pause for a person.
- [Testing and observability](/help/access-automation-testing-observability) — test a connection,
  dry-run, and read a run timeline.
- [Permissions](/help/access-automation-permissions) — who can configure, run, and hold credentials.
