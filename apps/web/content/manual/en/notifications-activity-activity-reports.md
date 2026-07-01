---
title: Activity & reports
order: 1
category: notifications-activity
subcategory: activity-reports
---

# Activity & reports

**Reports** is the estate-wide activity history: one chronological stream of who did what across
assets, application access, stock and users. Where the notification bell nudges you about a handful of
curated events, Reports is the durable, filterable record you go to when you need to answer "what
happened, and who did it".

## Who can see it

Reports is **administrator-only by default**, gated by the activity-log permission. If your role does
not hold it, the Reports page shows a calm access-denied message instead of the feed, and the
**Reports** link is hidden from the navigation. The same permission gates the recent-activity feed on
the dashboard. An administrator can grant the permission to the Member or Viewer role from the
role-permission settings — see [Permissions](/help/permissions).

## What it shows

The feed merges events from across the product into one chronological stream:

- **Assets** — history and assignments (assigned / released).
- **Access** — application access granted and revoked.
- **Stock** — consumable movements (stock in / out / adjustment).
- **Users** — the user lifecycle.

Each entry shows when it happened, the action, the entity it touched, the **actor** who did it (or
"system" for automated changes), and a one-line summary. Click an entry to open the record it refers
to.

## Filtering

Every filter narrows the feed on the server, so the totals and paging always reflect the real
filtered result — not a partial slice. Filters combine, and the whole filter set is kept in the page
URL, so a filtered view is shareable and survives Back navigation.

- **Scope tabs** — **All**, **Assets**, **Access**, **Stock**, **Users**, and **My history** (your
  own actions only).
- **Actor** — narrow to one person's actions (pinned to you on the My-history tab). The list offers
  only the people who have actually performed a recorded action, not the whole directory.
- **Action** — narrow to a single action type. The list offers only the action types that have
  actually occurred, so you never pick a filter that can return nothing.
- **Date range** — a quick preset (Today, Last 7 days, Last 30 days) or an exact from/to range.
- **Search** — free-text match across the visible entries.

A row of active-filter chips shows what is applied; clear them individually or all at once.

## Table and export

The feed is a single dense **table** — when, action, entity, actor and a one-line summary, one row per
event. Paging is real previous/next over the filtered result (pick how many rows per page), so each page
is one true slice of the server's count, never a partial window.

- **Export all (filtered)** — download a CSV of **every** event matching the current filters — the whole
  range, not just the page you are looking at. The file is streamed from the server, so it works even for
  large histories; the current page size and which page you are on are ignored.
- **Export visible** — download just the rows currently shown (the active filters **and** the current
  page) as a CSV.
- **Print** — print the current view.

Both CSV exports produce the same columns (when, action, entity, entity id, actor, summary) and are safe
to open in a spreadsheet. The difference is scope: **Export all** is the whole filtered history, while
**Export visible** and **Print** act only on the page in front of you. Narrow the feed with the filters
first to export just the slice you need.

## The security audit log

Reports covers the operational estate (assets, access, stock, people). The **security audit log** — a
separate view under Reports, at **Reports → Audit log** — is the read + export surface for the three
security trails that are not part of the activity feed:

- **Secrets** — every Secret Manager action: vaults and items created / updated / deleted, memberships
  granted / revoked, keypair and password events, exports, programmatic fetches by a service account,
  and single-item reveals in the UI.
- **Permissions** — every permission granted to or revoked from a role.
- **Service accounts** — the lifecycle of each service account: minted, rotated, revoked, restored, and
  permission changes.

It is gated by the **same permission as Reports** — no extra role is needed. Pick a **source** tab
(Secrets, Permissions, Service accounts), then narrow with the **actor**, **action** and **date-range**
filters. The secret log can also be pinned to a single **vault** or **item** — that is the per-vault /
per-item timeline (usually reached by a deep link, shown as an active-filter chip you can clear).

The list, the **Export all (filtered)** / **Export visible** / **Print** actions, and the paging behave
exactly like the activity feed above. The CSV columns are the audit fields (when, source, action,
actor, service account, vault, item, target, role, permission, detail).

**Secrets stay secret.** The secret audit log records only *metadata* — which vault, which item, who,
and when — never a secret's value. lazyit cannot decrypt your secrets, so a value can never appear here
or in the export; a vault or item that was later deleted simply shows its id.

## Reports vs the notification bell

They are different surfaces for different jobs:

- The [notification bell](/help/notifications-activity-notification-bell) is a small, curated set of
  nudges, kept for 90 days, shown to administrators (plus anything targeted to you).
- Reports is the full activity history, never pruned the way the bell is, and is the system of record
  for who did what across the estate.
