---
title: Applications
order: 1
category: applications-access
subcategory: applications
---

# Applications

The **Access** section is your catalog of the things people get access to: SaaS products
(GitHub, Jira, AWS), internal systems, and technical services (a VPN, an AD group). Each entry is
an **application**, and lazyit tracks who can reach each one. This page covers building and
organizing that catalog; granting access is covered in [Access grants](/help/applications-access-grants).

## What an application is

An application is just a named target that someone can hold access to. Only the **name** is
required — everything else is optional and there to help your team recognize and find it:

- **Vendor** — the provider behind it (Atlassian, Microsoft, AWS…).
- **Category** — a grouping for browsing (see below).
- **URL** — where the system lives. This can be a normal `https://…` address or a scheme-less
  internal host such as `vpn.corp.local`. For safety, only scheme-less hosts and `http(s)` links
  are accepted; other schemes are rejected.
- **Critical** — a flag for especially sensitive targets (see [Criticality & alerts](/help/applications-access-criticality-alerts)).
- **Description** and **Notes** — free text for context.
- **License & seats** — optional licensing details (seats purchased, cost per seat, renewal date). See
  [License & seats](#license--seats) below.

## Adding and editing applications

From the **Access** list, choose **New application**, fill in at least a name, and create it.
Open any application to see its **Details** and edit it. Two shortcuts speed up repetitive setup:

- **Clone** creates a new application pre-filled from an existing one — handy for similar systems.
  The clone is a *separate* application; you grant access to it independently.
- **Edit** updates any field at any time.

Creating and editing applications is everyday catalog work, available to administrators and
members. **Deleting** an application is an administrator-only action.

## Categories

Categories organize the catalog so it stays browsable as it grows. lazyit ships with a starter
set — **SaaS, Internal, Service, Third Party, Infrastructure, Other** — but categories are fully
yours to manage: rename them, add your own, or remove ones you don't use. A category is optional;
an application with no category is perfectly valid.

Deleting a category never deletes the applications in it — it simply **detaches** them, leaving
them uncategorized. Nothing is lost.

## Finding applications

The Access list supports searching by **name or vendor**, and filtering by **category** and by
**criticality** (critical only / non-critical / any). Each row also shows the count of **active
access** — how many people currently hold a live grant on that application — and, when you track
licensing, a **License** cell (used / purchased, with an over-allocation warning and the next
renewal date), so you can see at a glance which systems are in active use.

## License & seats

lazyit can track the licensing behind an application, so you can see at a glance how much of what
you pay for is actually in use. On the application form, fill in any of:

- **Seats purchased** — how many paid seats the license includes. Leave it blank to not track a limit.
- **Cost per seat** — the price of a single seat, per billing period. Enter it in normal units
  (e.g. `12.99`); lazyit stores the amount precisely.
- **Renewal date** — when the license next renews.

**Seats in use** is worked out for you: it's the number of *distinct people* who currently hold
active access to the application. Because one person can hold more than one grant on the same app,
lazyit counts *people*, not grants — so the number reflects real license consumption.

The Access list and each application's **Details** show **used / purchased**. When more people hold
access than there are purchased seats, lazyit flags the application as **over-allocated** — a nudge
to buy more seats or revoke access no longer needed. The warning is advisory: lazyit never blocks a
grant on seat count.

All license fields are optional — leave them blank for applications you don't license by seat.

## Deleting an application

Deleting is a **soft delete**: the application is hidden from the catalog but its record (and the
access history attached to it) is preserved, so audit trails stay intact. An administrator can
**restore** a deleted application later. Because deletes are reversible, lazyit never loses the
record of who once had access to what.

> Removing an application from the catalog does not "un-grant" anyone. Access is tracked
> separately and kept for audit — see [Access grants](/help/applications-access-grants).
