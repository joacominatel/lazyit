---
title: Using the chat
order: 1
category: ai-assistant
subcategory: using-the-chat
---

# Using the chat

The AI assistant is a chat inside lazyit. Ask in plain words — "which laptops are unassigned?", "assign
MBP-042 to Ana Ruiz", "take me to the VPN application" — and it looks things up, proposes changes, and
opens pages for you. It works **with your permissions**: it sees and does only what you could yourself,
and **every change waits for your approval**.

The chat appears once an administrator has turned the assistant on and your role includes **Use the AI
assistant** (`ai:use`). If you don't see it, ask an administrator — see [Permissions](/help/permissions).

> [!WARNING]
> Don't paste passwords, API keys or other secrets into the chat. What you write, and what the assistant
> reads to answer you, is sent to the AI provider your administrator configured — see
> [What leaves your server](/help/ai-assistant-overview#what-leaves-your-server).

## Open and close the chat

- Click the **chat bubble** in the top bar, or press **⌘J** (Mac) / **Ctrl+J** (Windows, Linux).
- On a wide screen the chat sits beside the page, so you can watch the page update. On a smaller screen it
  floats over the right side; on a phone it fills the screen.
- Press **Esc** or **×** to close it. Closing doesn't stop an answer in progress; the chat picks up where
  it was when you open it again.

### Make the chat wider

- Select **Expand** (the arrows next to **×**); select it again to go back to the normal width.
- Or drag the chat's left edge. With the keyboard, **Tab** to the edge and use **←** / **→** (hold
  **Shift** for bigger steps), **Home** / **End** for the narrowest and widest, and **Enter** — or a
  double-click — for the normal width.

A chat wider than normal floats **over** the page instead of squeezing it. lazyit remembers the width in
this browser.

## Ask something

Type in the box and press **Enter** to send; **Shift+Enter** starts a new line. Press **Stop** to end an
answer early — what was already written is kept.

While the assistant works you see one short line per step, such as "Done: Search assets". Repeated
lookups share a line with a count ("Done: Search users ×5"). Select **Show details** on a line to see
what it found.

### Choose the model

Select the **settings** button under the message box (it shows the chat's model) **before your first
message**:

- **Model** — the models your provider offers, or the administrator's **Default model**. For one that
  isn't listed, type its id in the search box and select **Use "‹id›"**.
- **Reasoning effort** — *Low*, *Medium* or *High*, when the provider supports it. Higher effort thinks
  longer and uses more tokens.
- **Temperature** — 0 to 2, only for a self-hosted OpenAI-compatible server.
- **Auto-approve basic changes** — see [Auto-approve](/help/ai-assistant-approvals#auto-approve).

Once the chat has started, model, effort and temperature are fixed (the button shows a **lock**); start a
new chat to change them. Auto-approve can be switched at any time.

### The current page

On a page about one item — an asset, a user, an application, a location, a consumable, a purchase, a
supplier — the chat shows a
chip like **About: Asset on this page**, so the assistant knows what "this one" means. Only the page
address and which record it is are sent, never what's on screen. Select **×** on the chip to leave it
out of your next message.

### Commands

Type **/** at the start of the message box to see the commands; keep typing to filter, **↑** / **↓** to
move, **Enter** or **Tab** to run, **Esc** to close.

| Command | What it does |
| --- | --- |
| `/copy` | Copies the whole conversation as Markdown — messages, answers, steps and change cards. |
| `/new` | Starts a new chat. |
| `/help` | Shows the commands and keyboard shortcuts. |
| `/model` | Opens the model picker; `/model <id>` sets it directly. Only before the first message. |
| `/auto on` · `/auto off` | Turns [auto-approve](/help/ai-assistant-approvals#auto-approve) on or off for this chat; `/auto` alone switches it. |

Commands run in your browser and are never sent to the provider. A message that merely starts with a
slash (a file path, say), or a command followed by words it doesn't understand, is sent as a normal
message.

## Approving what it proposes

When the assistant wants to create, edit, assign, archive or grant something, it shows a **card** with
exactly what will happen and waits for **Approve** or **Reject**. The approved change is made with your
account, and the page you have open refreshes by itself. How to read a card, bulk changes, passwords and
auto-approve are all in [Approving changes](/help/ai-assistant-approvals).

Cards and step lines are written in your language; a sentence lazyit has no translation for is shown in
English.

## When the assistant asks you for details

When it needs something it can't find in lazyit — the site new laptops go to, their serial numbers, a
date — the assistant shows a short **form** headed **The assistant asks**, instead of guessing.

- Fields marked **\*** are required; **Recommended** ones help it do a better job; **Optional** ones are
  under **More details**.
- Some forms ask for a list, one **row** per item: use **Add a row** and the **trash** icon, within the
  number of rows the form asks for.
- Lists of sites, categories, models, manufacturers, suppliers or consumables come from lazyit and show
  only what you can see.

| Button | What happens |
| --- | --- |
| **Send** | Your answer goes to the assistant. A missing or invalid field is highlighted and nothing is sent. |
| **Continue without** | The assistant carries on without the details — it may do less, or ask in words. |
| **Don't ask** | The assistant is told not to ask for these details again in this chat. |

While a form waits, the message box is paused with a **Go to the form** button, and the chat history
marks the chat **Needs your answer**. The form waits as long as a change card (30 minutes by default; it
shows **Answer by …**); if nobody answers, it expires and the assistant stops — send a new message to
continue. Answered forms stay in the conversation, read-only.

> [!WARNING]
> The assistant never asks for passwords, keys or other secrets in a form, and lazyit refuses a form that
> does. Don't type secrets into a form's text fields either.

## Filling a purchase from a document

On a purchase that has an invoice, an order or a delivery note in its **Documents**, the assistant can
fill the purchase for you: say *"here is this purchase order"*, or select **Ask AI to fill** on the
document (see [Purchases](/help/purchases-recording-purchases#reading-a-document-with-ai)). That button
opens the chat with the message written for you — read it and send it; nothing is sent before. If the chat
you had open already has messages, the button starts a **new chat** for it (the other one stays in your
history); an empty chat is reused, and anything you had typed in the box is kept after the message.

1. The assistant **reads the document**. This needs **Document extraction** on in
   [Settings → AI](/help/ai-assistant-setup#document-extraction), and sends the whole file to your AI
   provider, as reading it from the purchase does. It counts against your daily AI budget.
2. It asks what the document leaves **blank or ambiguous** in **one form** — which supplier (from your
   list), the reference or the invoice number, a model per line, where the units go, whether they
   already arrived.
3. It proposes the purchase as **one card** (or a few, for an existing purchase). Nothing is saved until
   you approve it.

What a supplier wrote is treated as **data, never as instructions**. Once the assistant has read a
document, every card in that chat shows **Based on content written by others**, and **nothing in that
chat is approved automatically any more** — start a new chat to get auto-approve back. Purchase
changes are never applied automatically anyway; see [Purchases](/help/ai-assistant-approvals#purchases).

## Links and opening pages

After a change, the chat shows an **Open ‹item›** button. If you ask it to take you somewhere ("open
Ana's laptop"), it opens the page — unless a form on the page has unsaved changes, in which case it shows
the **Open** button instead so nothing is lost.

Links to other websites open in a new tab and show their full address — check it before you click. Images
in answers are never loaded.

## Sources from the web

If your administrator turned on **web search**, the assistant can look things up on the internet when
lazyit's records and knowledge base don't have the answer; with it off, the assistant asks you for the
documentation instead. The pages it used appear under its answer as **Sources from the web**, each opening
in a new tab. Other people wrote them: check before you rely on them.

Once the assistant has searched the web in a chat, **nothing in that chat is auto-approved anymore** —
every change needs your approval. Start a new chat to use auto-approve again.

## Your chat history

Select **Chat history** at the top of the chat for your previous chats, grouped by day. Only you can see
them — administrators can't.

- Select a chat to continue it, or **New chat** to start over.
- Select the **trash** icon to delete a chat for good. The changes the assistant made stay in the activity
  log and the AI action log. A chat that is still answering can't be deleted — stop it first.

Chats are also deleted automatically after the retention your administrator set; the history shows it.

### Read-only chats

A chat becomes **read-only** — you can read it, but not continue it — when:

- an administrator changed the AI provider, or the default model the chat was using (a chat where you
  chose the model survives a change of default);
- an administrator turned off web search and the chat had it;
- lazyit was updated and the assistant's tools or instructions changed;
- the conversation grew too long for the model.

Select **Start a new chat** to go on.

## When something goes wrong

The chat says what happened in plain words and offers the next step — **Try again**, **Start a new
chat** or **Reconnect**. Closing the chat or losing the connection never loses an answer: it keeps going
on the server. For every message, its cause and its fix, see
[Troubleshooting](/help/ai-assistant-troubleshooting#chat-messages).
