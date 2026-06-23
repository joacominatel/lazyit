---
title: Assignments & history
category: assets
subcategory: assignments-history
order: 1
---

# Assignments & history

Ownership in lazyit is **not** a field you overwrite — it is a record of who held an asset and when.
This is what keeps the asset the first-class citizen: people rotate, assets persist, and the full
ownership trail is kept automatically. You manage owners from an asset's detail page, under
**Owners**.

## Assigning an owner

Open an asset, go to **Owners**, and choose **Assign user**. Pick the person and add an optional note
(for example "primary work laptop"). The asset now lists that person as an **active owner**.

A few things to know:

- **An asset can have several owners at once.** lazyit supports concurrent, shared ownership — for
  example a server that several people are responsible for. Assigning a second owner does not displace
  the first.
- **One active assignment per person per asset.** You can't assign the same person to the same asset
  twice while the first assignment is still active — release it first.
- You can only assign a **live** asset to a **live** user — deactivated assets and users can't be
  given new assignments.

## Releasing an owner

To end someone's ownership, choose **Release** next to that owner. Releasing one owner does not affect
the others. You can add a note explaining why (for example a return or a handover).

Releasing does **not** delete the assignment — it stamps it with a release time and moves it into the
ownership history. This is deliberate: there is no "delete assignment" action, because the point is to
keep the record. To move an asset from one person to another, **release** the old owner and **assign**
the new one.

> An owner who has left the company still appears as an active owner until you explicitly release the
> assignment — lazyit never silently drops ownership records.

## Quick actions from the assets list

You don't have to open an asset to manage its owner. Each row on the **Assets** list carries one
colored quick action:

- **Assign** (blue) on a row with no owner — opens the same picker as the detail page.
- **Unassign** (amber) on a row that already has one — asks you to confirm, then releases the current
  owner into the ownership history.

Each row also has a **…** menu with the rest: open the asset in a new tab, edit or clone it, assign or
remove its assignment, **change status** (a quick submenu), and delete. Changing status from here is
instant and reversible — no confirmation, just like the bulk action. These shortcuts respect your
permissions: you only see the actions you're allowed to run.

## Activity and ownership history

Every asset carries an **append-only activity log** — a timeline of discrete events, newest first.
The log is immutable: entries are written, never edited or deleted. You'll find it on the asset detail
page under **Activity**, and the ownership-specific entries under **Ownership history**.

Recorded events include:

- **Created** and **Deleted** / **Restored** — the asset's lifecycle.
- **Status** changes — for example Operational → In maintenance.
- **Location** and **Model** changes.
- **Specs** changes — edits to custom fields.
- **Assigned** and **Released** — ownership changes, naming the owner involved.

Each entry records **what changed, when, and by whom** (or "System" when lazyit acted on its own).
Together with soft delete everywhere, this gives you the audit trail of an asset's whole life without
any extra bookkeeping.

## What's next

- [Asset basics](/help/assets-asset-basics) — register and edit assets.
- [Locations](/help/assets-locations) — track where an asset lives.
