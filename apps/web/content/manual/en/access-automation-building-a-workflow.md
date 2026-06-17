---
title: Building a workflow
order: 2
category: access-automation
subcategory: building-a-workflow
---

# Building a workflow

You build workflows from an application's **Workflows** tab. A workflow needs two things: a
**connection** that says *how* lazyit reaches the external system, and a **sequence of steps** that
says *what* to do when the trigger fires.

## 1. Add a connection

A connection is the reusable transport-and-credential configuration for one external system. Open
the Workflows tab and choose **Add connection**, then pick a **type**:

- **API / HTTP** — call any HTTP/JSON API (for example, "create a Jira user").
- **Webhook** — send a signed POST to a webhook URL (for example, to your own automation platform).
- **Human task** — no external call; a person does the work (covered in
  [Manual tasks](/help/access-automation-manual-tasks)).

For an API connection you set a **Base URL** and an **Auth method** (none, Bearer token, Basic auth,
or an API-key header). For a Webhook connection you set the **Webhook URL**. The **type cannot be
changed** after creating the connection — recreate it if you need a different one.

### Credentials are write-only

If the connection needs a credential, you add it on the connection. The value is entered **once,
stored encrypted, and never shown again** — afterwards you can only **Replace** or **Remove** it.
lazyit only ever tells you whether a credential is *configured*, never its value. Holding credentials
can be separated from building workflows (see [Permissions](/help/access-automation-permissions)).

## 2. Add steps

Choose **New workflow**, give it a name, pick its **trigger** (Access granted or Access revoked) and
its connection, then add **steps** from the **Add step** palette. Three step types ship today:

- **API / HTTP** — an authenticated request (GET/POST/PUT/PATCH/DELETE) to a path on the connection's
  base URL.
- **Webhook** — a signed POST of your mapped payload to the connection's webhook URL.
- **Human task** — pause the run for a person to act.

(The Vendor SDK and MCP step types appear in the palette as **Coming soon** and cannot be added yet.)

Steps run **top to bottom**. Reorder them with the move-up/move-down controls. The trigger cannot be
changed after the workflow is created — recreate the workflow to change it.

## 3. Map data into the request

Each API or Webhook step has a **Data mapping**: a list of external fields and the value each one
takes. A value can be a fixed literal, a single **token** from the grant context, or several tokens
and text **composed** together. Tokens are inserted from a picker grouped by source:

- **Trigger event**, **Grantee** (email, first name, last name, id), **Application**, **Grant**, and
  the outputs of earlier **steps**.

You map by picking a context field, composing one, or — via **Advanced** — editing the raw JSON
mapping directly. Tokens are written like `{{ grantee.email }}`. Mapping is **values only**: you wire
context into fields, but you cannot write code or conditions in a mapping. The mapper warns you about
unbalanced braces, malformed tokens, or an unknown token source so you can fix it before saving.

You can also put a token **in the request path** — for example a user id in `/users/…/deactivate` —
and the editor previews the resulting path.

## 4. Decide success and what happens on failure

Each step's editor has **Retry** and **Flow** tabs:

- **Success status codes** — which HTTP responses count as success (the default is any `2xx`).
- **Retry on failure** — retry transient failures before giving up: set the number of **Attempts**,
  the **Backoff** (fixed or exponential), and a delay. Mark a step **Idempotent** only if it is safe
  to retry without provisioning twice.
- **On success →** continue to the next step (default), end the run as succeeded, or jump to a
  specific step.
- **On failure →** **Alert and stop** (default — mark the run failed and stop; the grant is never
  touched), **Escalate to a human** (pause and open a manual task), **Run a compensation step** (undo
  a half-finished change, then stop), or **Continue anyway**.

These success and failure edges are how you build an error-handling sequence rather than a blind
straight line.

## 5. Enable it

A workflow only fires when it is **Enabled**. Toggle it on from the workflow list (or in the builder)
when you are ready. Before you flip it on, validate it with a **dry-run** and a **Test connection** —
see [Testing and observability](/help/access-automation-testing-observability).

## Multi-grant deprovision policy

For an Access-revoked workflow you choose a **Deprovision policy**: deprovision **only when the last
active grant is revoked** (the safe default — never cuts off someone who still holds another valid
grant for that application), or **on each grant** revoked.
