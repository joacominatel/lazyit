---
title: Approving changes
order: 1
category: ai-assistant
subcategory: approvals
---

# Approving changes

Every change the assistant wants to make — creating, editing, assigning, archiving, granting or revoking
access — appears in the chat as a **card**, and nothing happens until you select **Approve** (unless you
turned on [auto-approve](#auto-approve) for basic changes in that chat). This page explains how to read a
card and what happens when you decide.

This is the in-app chat. External agents over MCP don't show lazyit cards — the client decides whether to
ask you; see [Claude Code & MCP](/help/ai-assistant-claude-code-mcp#before-you-connect-what-you-are-trusting).

## Reading a card

lazyit builds the card from the exact change that will run — **not** from what the assistant wrote. If
the two ever disagree, trust the card. Cards are shown in your language.

From top to bottom:

1. **The kind of change** — *Proposed change*, or *Sensitive change* for people's access, roles,
   identity, sign-in and instance-wide configuration — and a status stamp (**Pending**, **Done**,
   **Rejected**…).
2. **What will happen**, in one sentence — for example *"Give Ana Ruiz Admin access to VPN. This triggers
   automatic provisioning through the workflow set up for VPN."*
3. **Applies to** — the item that changes, with a link.
4. **Before → after** — each field that changes. Values such as passwords show as **Hidden**.
5. **Also affects** — other items the change touches, such as "Also affects 3 assignments".
6. **Before you approve** — plain warnings, such as *Creates access in an outside system through an
   automation*, *Also revokes the access grants tied to it*, *Sends notifications to people*, *This can't
   be undone* or *Touches an application marked critical*.
7. **Waits for you until…** — a proposal expires (30 minutes by default). After that, ask again.

Text other people wrote — an article, a note, a description — is shown as plain text in *italics*.

### "Based on content written by others"

If the assistant read content other people wrote before proposing the change — an article, a note, a
search excerpt, a web page — the card shows a yellow **Based on content written by others** note, with
links to what it read when there is a single page to link. Such content can hide instructions meant to
trick an AI. **Check that the change is really what you asked for.**

The note is deliberately cautious: text you wrote yourself, such as your own notes on an asset, counts
too.

## Approve or reject

- **Approve** makes the change with your account, exactly as shown. The card turns **Done**, an **Open**
  button takes you to the result, and the page you have open refreshes.
- **Reject** changes nothing. The assistant is told you declined — tell it what to do instead.

Nothing is ever approved by pressing Enter in the message box.

## Changes that need your password

Some cards ask for your **lazyit password** before **Approve** works — they show a **Needs your
password** tag:

- giving someone access or privileges;
- changing someone's role or identity;
- sending someone a way to sign in;
- **any change on an application marked critical.**

The password confirms it's you at the keyboard; your session is unaffected. After five wrong passwords
lazyit makes you wait, starting at a second and growing up to 15 minutes; the **Approve** button comes
back by itself. The wait is shared with the password on the MCP consent screen.

If your account signs in without a lazyit password (through your identity provider), these changes
can't be approved from the chat — make them from the item's own page.

## Several changes at once

**Up to 5 at a time.** At most **5** changes can wait for approval in one step. Ask for more — "move
these 25 laptops to storage" — and the assistant works in batches: it proposes 5, tells you where it is
(*"5 of 25"*), and proposes the next 5 once you have decided. If it tried more in one step, they show as
one line — *"20 changes couldn't be proposed"* — whose **Show details** says the limit was reached; that
is expected, not an error. If it stops before the end of a long list, tell it to continue.

**One card with pages.** The changes of one step appear as **one card with pages** — **Proposed changes
· 5 changes**, and which page you are on (**2 of 5**). Move with the arrows or the page numbers (the
left and right arrow keys work there too). Each page is a full card with its own **Approve** and
**Reject**; after you decide one, the card moves to the next still waiting.

**Approve all and Reject all** decide, one by one, every change still waiting **except** those that
need a closer look — the number on the button says how many. They never include:

- a change that needs your password;
- a *Sensitive change*;
- a change whose last decision was refused — for example because the item changed in the meantime.

The card lists how many were left out and why; decide those on their own page. **A change based on
content written by others is included**, so check its page first if that note is there. If some changes
can't be decided, the others still are, and the card links to the ones that failed.

## Lists of assets

For many assets at once, the assistant proposes **one card for the whole list** (up to 200 assets)
instead of a card each. You approve or reject the list as a whole; each asset is then created or
updated on its own, exactly as if you had done it by hand.

### Creating many assets at once

When you give the assistant a list — "add these 40 laptops", a pasted spreadsheet — the card shows:

- **What will happen** — for example *"Create 16 of 17 assets; 1 row skipped as requested."*
- **A summary** — rows, how many will be created, how many are skipped, and any **defaults applied**.
- **A table**, one row per asset (row number, name, asset tag, serial number, model, category, location,
  status, and **Problems**). It scrolls inside the card; on a phone, swipe it. **Only rows with
  problems** hides the rest.

Rows marked **Skipped — won't be applied** are shown with their reasons but are **never created**, even if the problem goes away.
The assistant only skips a row after telling you; a list with an unresolved problem (a model that doesn't
exist yet, a duplicate tag) is not proposed at all until it is fixed or skipped. So every row not
skipped was checked when the card was built.

**Duplicates.** A tag or serial number that already belongs to an asset is flagged with a link to it;
one repeated within the list says so ("… is also used by row 3"). If the check couldn't be completed —
you can't read every asset, or a value contains a comma — the card says so, and a taken value is refused
when that row runs.

**Default status.** An asset created without a status starts as **In storage**; the card marks it
**(default)**. If that's wrong, reject and tell the assistant the status.

If one row is refused when the list runs, the others still run and the assistant tells you which failed.

### Editing many assets at once

For similar edits to existing assets — a status, location, model, company, dates, cost or attributes —
the card is the same kind of table: the **Asset** column first, then the before → after of each field
that changes. If anyone edits one of those assets (or the model or location it points to) before you
approve, nothing is applied and the assistant can propose the list again. Asset tags and serial numbers
are changed one asset at a time.

## When the card changes under you

lazyit checks the change again when you approve. If something changed since the card was shown, nothing
is applied:

| You see | What it means |
| --- | --- |
| The card updates, with new warnings marked **New** | The change itself is different now — the application was marked critical, more assets use the category it archives. Review the updated counts (and type your password if it now needs one) and decide again. |
| The item changed since this was proposed | Someone edited it meanwhile. The assistant reads it again and can propose an updated change. |
| This proposal expired | Too much time passed. Ask again. |
| This change was already decided | You, or another window of yours, already decided it. |
| The AI assistant was turned off | It can't be approved from the chat now. |

## Auto-approve

In a chat where you trust the assistant with routine work, let it apply **basic changes** without a card:
turn on **Auto-approve basic changes** in the chat settings, or type `/auto on`. The first time, lazyit
explains what it does and asks you to confirm.

While it is on:

- **Basic edits apply right away** — creating or updating an asset, an article, a consumable and similar,
  including a whole [list of assets](#lists-of-assets). They run with your account, exactly as if you
  had approved them, and show as a compact **Applied automatically** record with the before → after.
- **These still show a card and wait for you:**
  - anything critical — roles, identity and sign-in, access grants, credentials, applications marked
    critical, any *Sensitive change*, anything that needs your password;
  - any change proposed **after the assistant read free text** — someone else's, or your own — in the
    same turn: an article, a note, a description, a search excerpt, the options you picked in one of its
    forms;
  - **every change in a chat where the assistant has searched the web**, for the rest of that chat.
- An **Auto** tag at the top of the chat reminds you it is on.

It applies **only to that chat** and is off in every new chat. Turn it off at any time with the same
switch or `/auto off`; switching it on never approves a card already waiting.

> [!WARNING]
> With auto-approve on, a basic change is made without you looking at it first. Use it for routine edits,
> and check the **Applied automatically** records as they appear.

## Categories, models and locations

The assistant can keep your classification tidy, always through a card:

- **Categories** — create, rename or edit asset, application and consumable categories, and archive one
  you no longer use. Knowledge-base folders are handled separately.
- **Asset models** — edit, archive and restore.
- **Locations** — edit (including moving under another parent), archive and restore.

An **archive** card carries *"Archives it. It can be restored later."* and says what still uses the item
— *"Also affects 12 assets"*, with a few named. If you can't see some of those records, **Used by** says
*"Unknown to you: …"* instead of zero: the item may still be in use. If the count changes before you
approve, the card updates as described in [When the card changes under you](#when-the-card-changes-under-you).
Archived categories are restored from **Settings → Taxonomies**, not from the chat.

## Asset tags

The assistant follows your [asset tag scheme](/help/configuration-asset-tag-scheme):

- Creating assets, it leaves the tag empty unless you give one, so lazyit assigns the next tag — exactly
  as by hand. It never composes a tag from the pattern.
- It changes **one asset's** tag when you ask, through the usual card.
- It changes the **instance-wide** scheme only when you explicitly ask for that — never to make one
  asset's tag fit. That card is a *Sensitive change* (*"Changes instance-wide configuration: it applies
  to everyone from now on."*) showing what changes and the next tag; auto-approve never skips it, and
  existing tags are never rewritten. Only people who can **Configure the instance** can make it.

Anyone who can create assets can have the assistant read the scheme and the next tag.

## Where approved changes are recorded

An approved change — by you or by auto-approve — is recorded like any change you make: in the item's
history and the activity log, under your name. lazyit also keeps every change the assistant proposed,
what you decided and whether it was applied automatically, in a permanent **AI action log** that stays
even if you delete the chat.
