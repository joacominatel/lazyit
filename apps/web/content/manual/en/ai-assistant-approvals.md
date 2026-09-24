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
**Based on content written by others** note with links to what it read. Content can contain instructions
meant to trick an AI. Check that the change is really what **you** asked for before approving.

## Approve or reject

- **Approve** makes the change with your account, exactly as shown. The card changes to **Done**, and an
  **Open** button takes you to the result. The page you have open refreshes by itself.
- **Reject** makes nothing change. The assistant is told you declined and can suggest something else — tell
  it what to change.

Each card is decided on its own; there is no "approve all". Nothing is ever approved by pressing Enter in the
message box.

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
for example, the application was marked critical in the meantime — nothing is applied. The card updates,
the new warnings are highlighted with a **New** tag, and it asks for your password if it now needs one.
Review it and decide again.

Other things you may see:

| Message | What it means |
| --- | --- |
| The item changed since this was proposed | Someone edited it meanwhile. Nothing was applied; the assistant checks again and can propose an updated change. |
| This proposal expired | Too much time passed. Ask again if you still want the change. |
| This change was already decided | You (or another window of yours) already approved or rejected it. |
| The AI assistant was turned off | An administrator turned the assistant off; the change can't be approved from the chat. |

## Auto-approve

If you trust the assistant with routine work in a chat, you can let it apply **basic changes** without a
card. Turn it on in the chat settings (the button under the message box) with **Auto-approve basic
changes**, or type `/auto on`. The first time, lazyit explains what it does and asks you to confirm.

While it is on:

- **Basic edits apply right away** — creating or updating an asset, an article, a consumable and similar.
  They run with your account and your permissions, exactly as if you had approved them, and show in the chat
  as a compact **Applied automatically** record with the item, a link to it and the before → after values.
- **Anything critical still shows a card and waits for you**: roles, identity and sign-in, access grants,
  credentials, applications marked critical, sensitive changes (the ones marked *Sensitive change*) and
  anything that needs your password.
- **A change proposed after the assistant read content other people wrote** also still shows a card —
  that content could be trying to steer the assistant.
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
