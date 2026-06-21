---
title: Versioning
category: knowledge-base
subcategory: versioning
order: 4
---

# Versioning

The Knowledge Base keeps a **history** of every article. An edit never silently destroys what an
article said before — each change is captured as a snapshot, so *"what did this runbook say last
quarter?"* always has an answer.

## How history is recorded

Every article carries an **append-only version history**. A new snapshot is written automatically
whenever a change is saved:

- **Creating** an article writes version 1.
- **Editing** writes a new version **whenever the title, body or excerpt actually changes**. Saving
  an edit that changes nothing meaningful does not add a version.
- **Publishing** and **unpublishing** also write a version, because they change the article's state.

Each snapshot is a full, frozen copy of the article's editable state at that moment — its title,
body, excerpt and published/draft status — together with **who made the change** and **when**.
Versions are numbered in order, starting at 1, and they are **never edited or deleted**: the history
is permanent and grows by one entry per change. This matches how the rest of lazyit keeps history
(asset history, the access ledger) — append-only, by design.

## Why it works this way

This is **auditability by default**. Because the prior body is always preserved:

- A mistaken edit never loses the original text.
- You can account for what a procedure said at any past point.
- Nothing about the live article is at risk when someone updates it.

## Viewing version history

Open any article and scroll to the **Version History** panel at the bottom of the page. Click
**History** to open a side panel listing every saved snapshot, newest first. Each row shows:

- The version number (1, 2, 3 …)
- The draft or published status at that moment
- Who made the change and when

Click **View** on any row to open a read-only view of that snapshot's full title and content.

## What you can and cannot do today

- **History is kept for every article, automatically** — you do not turn it on, and you cannot turn
  it off.
- **There is no "restore to a previous version" action** in the current release. History records
  what an article said; replaying an old version back onto the live article is not yet available. To
  revert a change, edit the article back to the earlier text (which itself becomes a new version).
- **A draft's history is as private as the draft.** Snapshots of a draft are visible only to its
  author, the same as the draft itself.

Because every snapshot is kept, an article's history only grows — and that is intentional. Nothing is
pruned, so the full trail is always there.
