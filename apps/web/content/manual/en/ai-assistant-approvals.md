---
title: Approving changes
order: 1
category: ai-assistant
subcategory: approvals
---

# Approving changes

Every change the assistant wants to make — creating, editing, assigning, archiving, granting or revoking
access — waits for you. It appears in the chat as a **card**, and nothing happens until you select
**Approve**, unless you turned on [auto-approve](#auto-approve) for basic changes in that chat. This page explains how to read a card and what happens when you decide.

## Reading a card

The card is built by lazyit from the exact change that will run — **not** from what the assistant wrote in
the chat. If the two ever disagree, trust the card.

From top to bottom:

1. **The kind of change** — *Proposed change*, or *Sensitive change* for changes to people's access, roles,
   identity or sign-in, and a status stamp (**Pending**, **Done**, **Rejected**…).
2. **What will happen**, in one sentence — for example *"Give Ana Ruiz Admin access to VPN. This triggers
   automatic provisioning through the workflow set up for VPN."*
3. **Applies to** — the item that changes, with a link to it.
4. **Before → after** — each field that changes, with its current value crossed out and the new value next
   to it. Values like passwords are shown as **Hidden**, never in clear.
5. **Also affects** — other items the change touches, such as "Also affects 3 assignments".
6. **Before you approve** — plain-language warnings, such as:
   - *Creates access in an outside system through an automation.*
   - *Also revokes the access grants tied to it.*
   - *Sends notifications to people.*
   - *This can't be undone.*
   - *Touches an application marked critical.*
7. **Waits for you until…** — a proposal expires after a while (30 minutes by default). After that, ask the
   assistant again.

Text that other people wrote — an article, a note, an application's description — is shown as plain text
in *italics* so you can tell it apart.

### "Based on content written by others"

If the assistant read content other people wrote before proposing the change, the card shows a yellow
**Based on content written by others** note with links to what it read (a search result has no single
page to link, so the note appears without one). Content can contain instructions meant to trick an AI. Check that the change is really what **you** asked for before approving.

## Approve or reject

- **Approve** makes the change with your account, exactly as shown. The card changes to **Done**, and an
  **Open** button takes you to the result. The page you have open refreshes by itself.
- **Reject** makes nothing change. The assistant is told you declined and can suggest something else — tell
  it what to change.

Each change is decided on its own card or page. Nothing is ever approved by pressing Enter in the message
box.

## Several changes at once

**Up to 5 at a time.** At most **5** changes can wait for your approval at the same time. When you ask for
more — "move these 25 laptops to storage" — the assistant works in batches: it proposes the first 5, tells
you where it is (*"5 of 25"*) and waits. Once you have decided on those, it proposes the next 5 by itself,
and so on until every change is done. If it stops before the end of a very long list, tell it to continue.

**One card with pages.** The changes of one batch appear as **one card with pages** instead of a stack of
cards:

- The top of the card says **Proposed changes · 5 changes** and which page you are on (**2 of 5**). Use the
  arrows, or select a page number, to move between them; on the page numbers, the left and right arrow keys
  work too. A decided page shows a check (approved or done) or a crossed circle (rejected or expired).
- Each page is the same card described above — what will happen, before → after, the warnings, the
  **Based on content written by others** note when it applies and, when it needs it, your password — with
  its own **Approve** and **Reject**. After you decide a page, the card moves to the next change still
  waiting.
- **Approve all** and **Reject all** decide, one by one, every change still waiting except those that need
  a closer look; the number on the button says how many. They **never** include a change that needs your
  password (roles, identity, access, sign-in, an application marked critical), a *Sensitive change*, or one
  whose last decision was refused — for example because the item changed in the meantime. The card lists
  how many were left out and why; decide those on their own page. A change based on content written by
  others **is** included, so check its page first if that note worries you.
- If some changes of a bulk action can't be decided, the others still are, and the card lists the ones that
  failed with a link to their page.

If the assistant tried to propose changes that were refused before they became a card, they appear as **one
line** — for example *"20 changes couldn't be proposed"* — with **Show details** for the reasons.

**One card for many edits.** For many similar edits to existing assets, the assistant can instead propose
**one card for all of them** (up to 200 assets): the same kind of table as a [batch of new
assets](#creating-many-assets-at-once), one row per asset — the **Asset** column first, then the before →
after of each field that changes. You approve or reject the list as a whole; each asset is then updated on
its own, exactly as if you had edited it by hand. If someone edits any of those assets before you approve,
nothing is applied and the assistant can propose the list again. Asset tags and serial numbers are still
changed one asset at a time. With [auto-approve](#auto-approve) on, such a list is applied without a card,
like other basic changes.

## Changes that need your password

Some changes ask for your **lazyit password** on the card before you can approve them:

- giving someone access or privileges;
- changing someone's role or identity;
- sending someone a way to sign in;
- **any change the assistant makes on an application marked critical.**

These warnings show a **Needs your password** tag. Type your password in the card and select **Approve**. It
confirms that it's really you at the keyboard; your session stays signed in either way.

| Message | What it means |
| --- | --- |
| That password is not correct | Type it again. |
| Too many wrong passwords. Try again in … | Wait the time shown; the Approve button comes back by itself. |
| Password confirmation isn't available with your sign-in method | Your account signs in without a lazyit password, so this change can't be approved from the chat. Make it from the item's own page. |

## When the card changes under you

lazyit checks the change again at the moment you approve. If something changed since the card was shown —
for example, the application was marked critical in the meantime, or more assets now use the category it
archives — nothing is applied. The card updates (with the counts that are true now), the new warnings are
highlighted with a **New** tag, and it asks for your password if it now needs one. Review it and decide
again.

Other things you may see:

| Message | What it means |
| --- | --- |
| The item changed since this was proposed | Someone edited it meanwhile. Nothing was applied; the assistant checks again and can propose an updated change. |
| This proposal expired | Too much time passed. Ask again if you still want the change. |
| This change was already decided | You (or another window of yours) already approved or rejected it. |
| The AI assistant was turned off | An administrator turned the assistant off; the change can't be approved from the chat. |

## Creating many assets at once

When you give the assistant a list — "add these 40 laptops", a pasted spreadsheet — it proposes **one card
for the whole batch** (up to 200 assets) instead of 40 separate cards. You approve or reject the batch as a
whole.

The card shows:

- **What will happen**, in one sentence — for example *"Create 16 of 17 assets; 1 row skipped as
  requested."*
- **A summary** — how many rows there are, how many will be created, how many are skipped, and any
  **defaults applied** (see below).
- **A table**, one row per asset: the row number, name, asset tag, serial number, model, category,
  location and status, plus a **Problems** column. The table scrolls inside the card; on a phone, swipe it
  sideways. Turn on **Only rows with problems** to hide the rows that are fine.

**Skipped rows.** A row marked **Skipped — won't be applied** is shown so you can see what was left out and
why (its reasons are in the **Problems** column), but it is **never created** — not even if the problem goes
away before you approve. The assistant only skips a row when it has told you so; a list where a row still
has an unresolved problem (a model that doesn't exist yet, a duplicate tag) is not proposed at all until
the assistant fixes it or skips that row. So every row on the card that is not skipped was checked and
ready when the card was built, and those rows — and only those — are created when you approve.

**Duplicates.** If an asset tag or serial number already belongs to an existing asset, the **Problems**
column says so and links to that asset. A value repeated between two rows of the same list is shown the
same way ("… is also used by row 3"). If the duplicate check could not be completed — you can't read every
asset, or a tag or serial number contains a comma and couldn't be looked up — the card says so: a row whose tag or serial is already taken is then refused when it runs, and the others still
run.

**Default status.** A new asset created by the assistant without a status starts as **In storage** (new
stock). The card marks such values **(default)** and lists them under **Defaults applied**. If that's not
what you want, reject the card and tell the assistant the status to use.

When the batch runs, each asset is created on its own, exactly as if you had created it by hand. If one row
is refused at that point, the others still run and the assistant tells you which row failed and why.

## Categories, models and locations

The assistant can also keep your classification tidy, always through a card:

- **Categories** — create, rename or edit asset, application and consumable categories, and archive one
  you no longer use (**category_create**, **category_update**, **category_archive**). Knowledge-base
  folders are handled separately.
- **Asset models** — edit, archive and restore a model (**asset_model_update**, **asset_model_archive**,
  **asset_model_restore**).
- **Locations** — edit (including moving one under another parent), archive and restore a location
  (**location_update**, **location_archive**, **location_restore**).

An **archive** card carries the *"Archives it. It can be restored later."* warning and says what still uses
the item — for example *"Also affects 12 assets"*, with a few of them named. If you're not allowed to see
some of those records, the card's **Used by** row says *"Unknown to you: …"* for them instead of showing zero: the item may
still be in use by records you can't see. Archived categories can't be restored from the chat; restore
them from **Settings → Taxonomies**.

## Asset tags

The assistant follows your instance's [asset tag scheme](/help/configuration-asset-tag-scheme):

- When it creates assets, it leaves the tag empty unless you give one, so lazyit assigns the next tag of the
  scheme — exactly as when you create an asset by hand. It never makes up a tag from the pattern.
- It can change **one asset's** tag when you ask, through the usual card.
- It changes the **instance-wide** scheme (**Settings → Instance → Asset tag scheme**) only when you
  explicitly ask it to change the general asset tag scheme — never just to make one asset's tag fit. That
  card is a *Sensitive change* with the warning *"Changes instance-wide configuration: it applies to
  everyone from now on."*, shows only what changes (prefix, suffix, digits or next number) before → after, plus the
  next tag, and
  always waits for you: [auto-approve](#auto-approve) never skips it. Existing tags are never rewritten.

Anyone who can create assets can have the assistant read the scheme (the pattern and the next tag), so it
follows it for them too; only administrators can change it. For someone who cannot create assets, the
assistant simply lets lazyit assign the tag.

## Auto-approve

If you trust the assistant with routine work in a chat, you can let it apply **basic changes** without a
card. Turn it on in the chat settings (the button under the message box) with **Auto-approve basic
changes**, or type `/auto on`. The first time, lazyit explains what it does and asks you to confirm.

While it is on:

- **Basic edits apply right away** — creating or updating an asset, an article, a consumable and similar.
  They run with your account and your permissions, exactly as if you had approved them, and show in the chat
  as a compact **Applied automatically** record with the item, a link to it and the before → after values.
  A [batch of new assets](#creating-many-assets-at-once) is a basic change too: with auto-approve on, the
  whole list (up to 200 assets) is created without a card, and the record shows its table.
- **Anything critical still shows a card and waits for you**: roles, identity and sign-in, access grants,
  credentials, applications marked critical, sensitive changes (the ones marked *Sensitive change*) and
  anything that needs your password.
- **A change proposed after the assistant read content other people wrote** also still shows a card —
  that content could be trying to steer the assistant.
- **Once the assistant has searched the web in a chat**, nothing in that chat is auto-approved anymore:
  the search results stay in the conversation.
- An **Auto** tag at the top of the chat reminds you the mode is on.

It applies **only to that chat** and is off in every new chat. Turn it off at any time with the same switch
or `/auto off`; a card already waiting for you is never approved by switching it on.

> [!WARNING]
> With auto-approve on, a basic change is made without you looking at it first. Use it for chats where you
> are doing routine edits, and check the **Applied automatically** records as they appear.

Every automatic change is recorded like any other change you make — in the item's history and the activity
log, under your name — and the AI action log notes that it was applied automatically.

## Where approved changes are recorded

An approved change is made with your account, so it is recorded like any change you make yourself: in the
item's history and in the activity log, under your name. lazyit also keeps every change the assistant
proposed, and what you decided, in a permanent AI action log that stays even if you delete the chat.
