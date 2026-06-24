---
title: Global search
order: 1
category: notifications-activity
subcategory: global-search
---

# Global search

Global search is the command palette that spans the whole product: one box that searches across
assets, articles, users, locations, applications and topology nodes at once. It is typo-tolerant and
ranked, so a near-miss or a partial word still finds the record.

## Opening it

- Press **⌘K** (macOS) or **Ctrl+K** (Windows / Linux) from anywhere in the app, **or**
- Click the **search box** in the top bar.

Start typing and results appear, grouped by kind. Move through them with the **↑ / ↓** arrows, press
**Enter** to open the highlighted result, and **Esc** to close.

## What it searches

Six kinds of records are indexed:

- **Assets** — by name, asset tag or serial.
- **Articles** — Knowledge Base articles, including their body text, so a procedure inside an article
  is findable. Only published articles are searchable; drafts never appear.
- **Users** — by name and email.
- **Locations** — by name and address.
- **Applications** — by name and vendor.
- **Topology nodes** — servers, VMs, containers and the rest of the infrastructure map, by label, IP
  address or linked asset name.

Use the **filter chips** above the results to scope the search to a single kind, or leave it on
**All** to search everything. Selecting a result navigates straight to that record.

## Quick View — preview a result without leaving search

Each result row carries a small **eye** that appears when you hover the row (or when the keyboard
selection lands on it). Hover the eye to peek at a generous **preview** of that record, or click it to
**pin** the preview open. Pinned previews show an **"Open full record"** link that opens the entity in
a new tab, so you can confirm you have the right "Juan D." or the right `LZ-0042` before you navigate.

Only one preview is open at a time, and **Esc** closes it. Most previews render instantly from the
search result itself; an asset's or user's richer details (owner, location, role) load on demand the
moment you open the preview, so opening it never slows the search down.

## What you see depends on your permissions

Search results respect access control:

- **Users** are dropped from search for anyone who cannot read the user directory (a Viewer by
  default), so search never becomes a back door to enumerate names and emails.
- **Articles** are filtered to the folders you can actually open, so a restricted article never
  surfaces to someone who could not otherwise read it.

So two people may get different results for the same query — by design.

## When search is unavailable

Search is powered by a separate search service, and it is deliberately **fail-soft**: if that service
is down, the rest of lazyit keeps working and the palette shows a clear "search unavailable" message
rather than pretending there are no results. Retry once the service is back.

## Keeping the index fresh

The search index updates automatically as records are created, edited and removed. Two situations
call for a manual rebuild:

- **After the first deploy**, to populate the index from the existing database.
- **After the search service has been down**, to repair any drift (for example a deletion that did
  not reach the index while it was offline).

An operator rebuilds every index by running `reindex:all` from the API (`bun run reindex:all`). This
is an authoritative, zero-downtime rebuild: it loads exactly the live, visible set into a fresh index
and swaps it in, evicting any stale entries, while search keeps serving the old index until the swap
completes. The Knowledge Base in particular needs this run after a fresh deploy, or article search
returns nothing until it does.
