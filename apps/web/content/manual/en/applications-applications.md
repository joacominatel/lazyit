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

- **Publisher** — who makes the software (Atlassian, Microsoft, AWS…). It suggests the publishers
  already in use. This is not who you buy it from — that is a [supplier](/help/purchases-recording-purchases).
- **Category** — a grouping for browsing (see below).
- **URL** — where the system lives. This can be a normal `https://…` address or a scheme-less
  internal host such as `vpn.corp.local`. For safety, only scheme-less hosts and `http(s)` links
  are accepted; other schemes are rejected.
- **Critical** — a flag for especially sensitive targets (see [Criticality & alerts](/help/applications-criticality-alerts)).
- **Description** and **Notes** — free text for context.
- **License & seats** — optional licensing details (seats purchased, cost per seat, renewal date). See
  [License & seats](#license--seats) below.

## Adding and editing applications

From the **Access** list, choose **New application**, fill in at least a name, and create it.
Open any application to see its page (below) and choose **Edit** at the top. Two shortcuts speed up
repetitive setup:

- **Clone** creates a new application pre-filled from an existing one — handy for similar systems.
  The clone is a *separate* application; you grant access to it independently.
- **Edit** updates any field at any time. To remove a value, empty the field (or set the category to
  none) and save.

Creating and editing applications is everyday catalog work, available to administrators and
members. **Deleting** an application is an administrator-only action.

## The application page

Opening an application shows everything about it on one page, laid out like an asset or a person:

- **The header** — the name, a **Critical** badge when the application is marked critical, and the
  publisher, category and URL. The main action sits on the right: **Grant access** for
  administrators, or **Request access** for everyone else (it turns into *Access requested* or
  *You have access* when that already applies). **Edit** is next to it; **Clone** and **Delete
  application** are in the **⋯** menu.
- **Needs attention** — a short row of what needs follow-up, most urgent first: grants that have
  expired and wait to be revoked, more people than purchased seats, a license renewal within 30 days
  or already past, grants expiring within 30 days, deactivated people who still hold access, and
  requests waiting for a decision. When nothing needs attention, the row is not shown.
- **Key facts** — **People with access** (distinct people, with the number of active grants),
  **Seats** (used / purchased, with a bar), **Renewal**, and **Pending requests**. People with
  access and Pending requests open their tab when you click them.
- **Tabs** — **Access** (who holds access, see [Access grants](/help/applications-access-grants)),
  **Requests** (this application's access requests, see
  [Access requests](/help/applications-access-requests)), **Automation** (its workflows, recent runs
  and connection, see [Access automation](/help/access-automation-concepts)), **Activity** (every
  grant and revocation, newest first) and **About** (description, notes and license details). A tab
  appears only if you can see what it lists: by default members see Access and Requests, and only
  administrators see Automation and Activity. The open tab is kept in the address, so a shared link
  opens on the same tab.
- **The side column** — the details (publisher, category, URL, criticality, when it was added and
  last updated) and the knowledge-base articles linked to the application. On a phone the side
  column moves below the tabs.

## Categories

Categories organize the catalog so it stays browsable as it grows. lazyit ships with a starter
set — **SaaS, Internal, Service, Third Party, Infrastructure, Other** — but categories are fully
yours to manage: rename them, add your own, or remove ones you don't use. A category is optional;
an application with no category is perfectly valid.

Deleting a category never deletes the applications in it. When it still has applications, lazyit
shows you which ones and asks for **one decision for all of them**: leave them uncategorized, move
them to another category, or, if you can create categories, type a name to create one right there
and move them into it. Nothing is lost, and restoring the category later does not bring them back.

## Finding applications

The Access list supports searching by **name or publisher**, and filtering by **category** and by
**criticality** (critical only / non-critical / any). Each row also shows the count of **active
access** — how many people currently hold a live grant on that application — and, when you track
licensing, a **License** cell (used / purchased, with an over-allocation warning and the next
renewal date), so you can see at a glance which systems are in active use.

**Export CSV** downloads every application matching the current search and the category and
criticality filters — see [Exporting data](/help/notifications-activity-data-export).

## License & seats

lazyit can track the licensing behind an application, so you can see at a glance how much of what
you pay for is actually in use. On the application form, fill in any of:

- **Seats purchased** — how many paid seats the license includes. Leave it blank to not track a limit.
- **Cost per seat** — the price of a single seat, per billing period. Enter it in normal units, in
  your language's number format (`12.99` in English, `12,99` in Spanish — see
  [entering amounts](/help/assets-asset-basics#entering-amounts)); lazyit stores the amount precisely.
- **Renewal date** — when the license next renews.

**Seats in use** is worked out for you: it's the number of *distinct people* who currently hold
active access to the application. Because one person can hold more than one grant on the same app,
lazyit counts *people*, not grants — so the number reflects real license consumption.

The Access list and each application's **Seats** key fact show **used / purchased**; the **About** tab
lists all three license fields. When more people hold access than there are purchased seats, lazyit
flags the application as **over-allocated**, in the list and in the page's *Needs attention* row — a nudge
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
