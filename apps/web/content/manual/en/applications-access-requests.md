---
title: Access requests
order: 4
category: applications-access
subcategory: access-requests
---

# Access requests

> **Coming, not here yet.** Today, access is **granted directly** by an administrator — there is
> no request-and-approve queue. This page describes what is planned so you know how the model is
> meant to grow.

## How access works today

Right now the flow is simple and deliberate: an administrator decides someone should have access
to an application and creates the grant for them. There is no pending state, no approver step and
no waiting — see [Access grants](/help/applications-access-grants). If your process needs an
approval, run it in your existing channel (a chat message, a ticket in another tool) and record
the outcome by granting access, using the grant's **notes** to capture the reason.

## What an access request will be

An **access request** is a planned addition: instead of access being created directly, a person
(or someone on their behalf) **requests** access to an application, and the request moves through
an approval workflow — requested, then approved or rejected. **On approval, it produces an access
grant** exactly like the ones you create today.

This is designed to slot in **without changing what already exists**. Grants stay the append-only
record of who-has-access; requests simply become one of the ways a grant comes to be. Direct
granting will remain available.

## Why it is deferred

lazyit ships access management without an approval workflow on purpose, to keep the first version
focused and predictable. Approver rules — who signs off, and whether that is tied to the
application, a team or a role — are a design decision best made when the workflow is built rather
than guessed at up front.

> When access requests arrive, this page will be replaced with how to use them. Until then, treat
> direct grants (with good notes) as the supported way to give and track access.
