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

## Ask something

Type in the box at the bottom and press **Enter** to send. **Shift+Enter** starts a new line.

While the assistant works you see what it is doing, one short line per step — for example
"Done: Asset search". Select **Show details** on a line to see what it found. The answer itself appears
as it is written.

To stop an answer, press the **Stop** button. What was already written is kept.

> [!WARNING]
> Don't paste passwords, API keys or other secrets into the chat. What you write, and what the assistant
> reads to answer you, is sent to the AI provider your administrator configured.

### The current page

When you're on a page about one item — an asset, a user, an application, a location, a consumable — the
chat shows a chip like **About: Asset on this page** above the message box. The assistant then knows which
item you mean by "this one". Only the page address is sent, never what's on the screen. Select **×** on the
chip to leave it out of your next message.

## Changes need your approval

The assistant never changes anything on its own. When it wants to create, edit, assign, archive or grant
something, it shows a **card** describing exactly what will happen, and waits for you to **Approve** or
**Reject** it. See [Approving changes](/help/ai-assistant-approvals).

After you approve, the change is made with your account, like any other change you make, and the page you
have open refreshes by itself — a new asset appears in the list you're looking at.

## Links and opening pages

When the assistant creates or changes something, the chat shows an **Open ‹item›** button that takes you to
it. If you ask it to take you somewhere ("open Ana's laptop"), it opens that page for you — unless you have
unsaved changes in a form, in which case it shows the **Open** button instead so nothing you typed is lost.

Links the assistant writes to other websites open in a new tab and show the site's address next to them.
Images in answers are never loaded.

## Your chat history

Select **Chat history** at the top of the chat to see your previous chats, grouped by day. Only you can see
your chats — administrators can't read them.

- Select a chat to continue it.
- Select **New chat** to start over.
- Select the **trash** icon to delete a chat. Deleting removes the conversation for good; the changes the
  assistant made stay in the activity log. A chat that is still answering can't be deleted — stop it first.

Chats are also deleted automatically after the number of days your administrator set; the history shows it.

### Read-only chats

A chat becomes **read-only** when your administrator changes the AI provider or model, or when the
conversation grows too long for the AI to follow. You can still read it; select **Start a new chat** to go on.

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
