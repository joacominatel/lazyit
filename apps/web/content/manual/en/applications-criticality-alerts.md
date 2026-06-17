---
title: Criticality & alerts
order: 3
category: applications-access
subcategory: criticality-alerts
---

# Criticality & alerts

Some applications matter more than others. Marking an application **Critical** tells lazyit it is
especially sensitive — production infrastructure, finance systems, anything where you want a
closer eye on who gets in. Criticality is a single flag you set on the application, and it changes
two things: how the app is **shown**, and what happens **when access is granted**.

## Marking an application critical

When you create or edit an application, turn on **Critical**. lazyit then:

- Shows a **Critical** badge on the application's row and detail page.
- Lets you **filter** the Access list to *critical only* (or *non-critical*), so you can review
  your most sensitive systems on their own.
- Surfaces a count of active access on critical applications for at-a-glance review.

Critical is purely your judgment call — lazyit does not decide it for you, and changing it later
is just an edit.

## Alerts when critical access is granted

The point of the flag is visibility at the moment that matters. **When someone is granted access
to a critical application, lazyit raises a notification** so administrators see it without having
to go looking. The alert names the grantee and the application and is marked as a warning. It
appears in the in-app notification bell.

A second, related alert fires whenever a grant is given at an **admin level** (an access level of
`admin` or `administrator`) — even on a non-critical application — because admin-level access is
worth knowing about wherever it lands.

These alerts are about *awareness*, not enforcement: they do not block the grant or require
approval. The grant goes through immediately; the notification simply makes sure the right people
notice. Each grant raises its own alert, so re-granting access later is flagged again.

> The notification bell and how to read and clear alerts are covered under **Notifications &
> Activity** in this Help. Criticality alerts are one of the curated events that land there.

## What criticality does not do

- It does **not** restrict who can be granted access — permissions decide that, not the flag.
- It does **not** auto-revoke or expire anything.
- It does **not** change how a grant behaves; a critical app's grants work exactly like any
  other's (see [Access grants](/help/applications-access-grants)).

Think of Critical as a spotlight: it makes the sensitive applications easy to find and makes new
access to them impossible to miss.
