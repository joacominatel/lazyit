---
title: Using the chat
order: 1
category: ai-assistant
subcategory: using-the-chat
---

# Using the chat

The AI assistant is a chat inside lazyit. You ask in plain words — "which laptops are unassigned?",
"assign MBP-042 to Ana Ruiz", "take me to the VPN application" — and the assistant looks things up,
proposes changes, and opens pages for you. It works **with your permissions**: it can only see and do what
you can see and do yourself.

The chat only appears when an administrator has turned the assistant on and your role includes the
**Use the AI assistant** permission (`ai:use`). If you don't see it, ask an administrator — see
[Permissions](/help/permissions).

## Open and close the chat

- Click the **chat bubble** in the top bar, or press **⌘J** (Mac) / **Ctrl+J** (Windows, Linux).
- On a wide screen the chat sits beside the page, so you can keep working and watch the page update. On a
  smaller screen it floats over the right side, and on a phone it fills the screen.
- Press **Esc** or the **×** to close it. Closing the chat doesn't stop an answer that is in progress; when
  you open it again, it picks up where it was.

### Make the chat wider

When an answer or a change card needs more room, widen the chat:

- Select **Expand** (the arrows next to **×**) to widen it; select it again to go back to the normal width.
- Or drag the chat's left edge. With the keyboard, move to the edge with **Tab** and use **←** / **→**
  (hold **Shift** for bigger steps), **Home** / **End** for the narrowest and widest, and **Enter** to go
  back to the normal width. Double-clicking the edge does the same.

A chat wider than normal floats **over** the page instead of squeezing it; the page underneath stays as it
was. lazyit remembers the width you chose in this browser. On a phone the chat always fills the screen.

## Ask something

Type in the box at the bottom and press **Enter** to send. **Shift+Enter** starts a new line.

While the assistant works you see what it is doing, one short line per step — for example
"Done: Search assets". When it repeats the same lookup several times in a row, the steps share one line
with a count, like "Done: Search users ×5". Select **Show details** on a line to see what it found. The
answer itself appears as it is written.

To stop an answer, press the **Stop** button. What was already written is kept.

> [!WARNING]
> Don't paste passwords, API keys or other secrets into the chat. What you write, and what the assistant
> reads to answer you, is sent to the AI provider your administrator configured.

### Commands

Type **/** at the start of the message box to see the commands. Keep typing to filter them, move with
**↑** / **↓**, and press **Enter** (or **Tab**) to run one; **Esc** closes the list. You can also type a
command in full, like `/copy`, and press **Enter**.

| Command | What it does |
| --- | --- |
| `/copy` | Copies the whole conversation to the clipboard as Markdown — your messages, the answers, the steps and the change cards. |
| `/new` | Starts a new chat. |
| `/help` | Shows the commands and keyboard shortcuts inside the chat. |
| `/model` | Opens the model picker. `/model <id>` sets the model directly — for example `/model gpt-4o-mini`. Only before the chat's first message. |
| `/auto on` · `/auto off` | Turns [auto-approve](/help/ai-assistant-approvals) on or off for this chat. `/auto` alone switches it. |

Commands run in your browser: they are never sent to the assistant or the AI provider. If your message just
starts with a slash but isn't a command (say, a file path), it is sent as a normal message — and so is a
command followed by words it doesn't understand, like `/auto maybe`.

### Choose the model

Each chat can use its own model. Select the **settings** button on the right under the message box — it
shows the model the chat uses — to open the chat settings:

- **Model** — the models your AI provider offers, and the **Default model** your administrator chose. To
  use a model that isn't listed (a custom deployment, say), type its id in the search box and select
  **Use "‹id›"**. If the provider doesn't return its list, you can still type an id or keep the default.
- **Reasoning effort** — *Low*, *Medium* or *High*, when your provider supports it. Higher effort thinks
  longer and uses more tokens. **Default** uses your administrator's setting.
- **Temperature** — from 0 to 2, only for providers that take it (a self-hosted, OpenAI-compatible
  server). Leave it empty for the default.
- **Auto-approve basic changes** — see [Auto-approve](/help/ai-assistant-approvals).

Choose these **before your first message**. Once the chat has started, the model, effort and temperature
are fixed for that chat — the button shows a **lock** — and you start a new chat to use a different one.
Auto-approve can be switched at any time.

If the provider doesn't serve the model you typed, the chat tells you when you send the first message;
start a new chat and pick another.

### The current page

When you're on a page about one item — an asset, a user, an application, a location, a consumable — the
chat shows a chip like **About: Asset on this page** above the message box. The assistant then knows which
item you mean by "this one". Only the page address is sent, never what's on the screen. Select **×** on the
chip to leave it out of your next message.

## Changes need your approval

The assistant never changes anything on its own. When it wants to create, edit, assign, archive or grant
something, it shows a **card** describing exactly what will happen, and waits for you to **Approve** or
**Reject** it. See [Approving changes](/help/ai-assistant-approvals).

If you turn on **auto-approve** in a chat, basic changes are applied without a card and show as
**Applied automatically**; anything critical still waits for you. An **Auto** tag at the top of the chat
reminds you it is on.

After you approve, the change is made with your account, like any other change you make, and the page you
have open refreshes by itself — a new asset appears in the list you're looking at.

## When the assistant asks you for details

Sometimes the assistant needs information it can't find in lazyit — the site the new laptops go to, their
serial numbers, a date. Instead of guessing, it shows a short **form** in the chat, headed **The assistant
asks**, with a title and a line explaining why it needs the details. The assistant writes the form itself,
so its questions change with what you asked.

- Fields marked **\*** are **required**: the assistant can't go on without them.
- Fields tagged **Recommended** would help it do a better job.
- **Optional** fields are tucked under **More details** — open it only if you want to add them.
- Some forms ask for a list, one **row** per item (one per laptop, say). Use **Add a row** and the
  **trash** icon on a row, within the number of rows the form asks for.
- Lists of sites, categories, models or manufacturers come from lazyit and only show what you can see.

Then choose one of three buttons:

| Button | What happens |
| --- | --- |
| **Send** | Your answer goes to the assistant and it carries on with it. If something is missing or doesn't fit, the field is highlighted and nothing is sent. |
| **Continue without** | You skip the form this time. The assistant carries on without the details — it may do less, or ask you in words. |
| **Don't ask** | You decline. The assistant is told not to ask for these details again in this chat. |

While a form is waiting, the message box is paused and shows what the assistant asked, with a **Go to the
form** button. The chat history marks the chat **Needs your answer**. You can close the chat and come back
later — the form is still there.

A form waits for the same time as a change card (30 minutes by default; the form shows **Answer by …**).
If nobody answers in time, the form closes as **expired** and the assistant stops; send a new message to
continue. After you select **Send**, the form shows **Sent** until the assistant picks your answer up.

Once answered, the form stays in the conversation read-only, showing what you sent (or that you skipped or
declined it).

> [!WARNING]
> The assistant never asks for passwords, keys or other secrets in a form, and lazyit refuses a form that
> does. Don't type secrets into a form's text fields either.

## Links and opening pages

When the assistant creates or changes something, the chat shows an **Open ‹item›** button that takes you to
it. If you ask it to take you somewhere ("open Ana's laptop"), it opens that page for you — unless you have
unsaved changes in a form, in which case it shows the **Open** button instead so nothing you typed is lost.

Links the assistant writes to other websites open in a new tab and show their full address next to them — check it before you click.
Images in answers are never loaded.

## Sources from the web

If your administrator turned on **web search** (Settings → AI), the assistant can look things up on the
internet — but only when lazyit's records and knowledge base don't have the answer. When it doesn't know a
product or term and web search is off, it asks you for the documentation instead.

When it searched, the pages it used appear under its answer as **Sources from the web**. Each one opens in a
new tab. They were written by other people: check them before you rely on them. Once the assistant has
searched the web in a chat, nothing in that chat is auto-approved anymore: every change it proposes there
needs your approval, even with auto-approve on. Start a new chat to use auto-approve again.

## Your chat history

Select **Chat history** at the top of the chat to see your previous chats, grouped by day. Only you can see
your chats — administrators can't read them.

- Select a chat to continue it.
- Select **New chat** to start over.
- Select the **trash** icon to delete a chat. Deleting removes the conversation for good; the changes the
  assistant made stay in the activity log. A chat that is still answering can't be deleted — stop it first.

Chats are also deleted automatically after the number of days your administrator set; the history shows it.

### Read-only chats

A chat becomes **read-only** when your administrator changes the AI provider, when they turn off web search
and the chat was using it, when they change the default
model and the chat was using the default, or when the conversation grows too long for the AI to follow. A
chat where you chose the model yourself keeps working when only the default changes. You can still read it; select **Start a new chat** to go on.

## When something goes wrong

The chat tells you in plain words and offers what you can do next:

| Message | What to do |
| --- | --- |
| The AI provider is busy / isn't responding | Select **Try again**, or wait a moment. |
| This conversation is too long to continue | Select **Start a new chat**. |
| Another window is already answering in this chat | The chat shows that answer; wait for it to finish. |
| The daily AI budget has been reached | Try again tomorrow, or ask an administrator. |
| The AI provider rejected the credentials | An administrator needs to check the AI settings. |
| Connection lost | Select **Reconnect**. The answer keeps going on the server; nothing is lost. |
| The AI assistant was turned off | The chat closes. An administrator turned the assistant off. |
