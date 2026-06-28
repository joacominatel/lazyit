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

## Restoring a previous version

If an edit went wrong, you can **restore** an earlier snapshot. Open the **History** panel and click
**Restore** on any past version (the latest version is the live content, so it has nothing to
restore). Confirm, and lazyit re-applies that version's **title, body and excerpt** to the live
article.

Restoring is itself an edit, so it follows the same append-only rule: it writes a **new** version on
top — it never rewrites or deletes the history. A few things to know:

- It restores the **content** (title, body, excerpt). It does **not** change the article's
  published/draft **status** — a published article stays published, a draft stays a draft. Use
  Publish/Unpublish for that.
- Restoring to text identical to the current article does nothing (no new version is written).
- Restore needs **edit permission** and, like every edit, you must be the article's author.

## What you can and cannot do

- **History is kept for every article, automatically** — you do not turn it on, and you cannot turn
  it off.
- **A draft's history is as private as the draft.** Snapshots of a draft are visible only to its
  author, the same as the draft itself.

Because every snapshot is kept, an article's history only grows — and that is intentional. Nothing is
pruned, so the full trail is always there.
