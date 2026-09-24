---
title: AI assistant — overview
order: 1
category: ai-assistant
subcategory: overview
---

# AI assistant — overview

lazyit can include an **AI assistant**: a chat in the top bar where people ask questions about the
estate ("which laptops are unassigned in Madrid?") and ask for changes ("assign MBA-017 to Juan"). The
assistant works through lazyit itself — it reads and changes records with the same rules and the same
permissions as the person using it — and **every change it proposes waits for that person to approve
it** before anything happens.

lazyit can also let **external AI agents** — Claude Code, OpenAI Codex, Cursor, OpenCode and other
clients that speak the Model Context Protocol (MCP) — work with lazyit on a person's behalf.

## Off by default

Nothing about AI is active on a new or upgraded instance. An administrator turns each part on in
**Settings → AI**:

- **The assistant** needs an AI provider (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible
  server, including one you host), a model and — for the hosted providers — an API key. See
  [AI assistant — setup](/help/ai-assistant-setup).
- **External AI agents (MCP)** have their own switch. They work even with no provider configured,
  because the agent brings its own model.

Turning either off again is immediate and keeps the configuration for later.

Once MCP is on, the well-known clients are allowed out of the box, and — by default — any other client
with an `https://` sign-in callback may ask a person for access; the person always sees who is asking
before approving. An administrator can narrow this to a fixed list. See
[AI assistant — setup](/help/ai-assistant-setup#allowed-clients).

## What leaves your server

When someone uses the in-app assistant, lazyit sends to the provider you chose:

- the messages they type;
- the page they are on — its address and the record it shows, never the rest of the page;
- the records the assistant reads to answer: assets, people, applications and access, stock,
  knowledge-base articles — only what **that person** is allowed to see.

It never sends vault secrets or passwords, and the provider's API key is stored encrypted and never
shown again. The administrator acknowledges this before the assistant can be turned on. Conversations
are also kept on your server for a retention period the administrator chooses (90 days by default,
between 7 and 3650), after which they are deleted; the record of what the assistant actually changed
is kept regardless.

External agents over MCP use their own model: what they read from lazyit goes to whatever provider
that agent uses, under the control of the person running it.

## Who can use it

Two permissions govern AI, both granted to Administrators and Members by default and configurable in
[Permissions](/help/permissions):

| Permission | What it allows |
| --- | --- |
| **Use the AI assistant** (`ai:use`) | See the chat and use it, once an administrator has turned the assistant on. |
| **Connect external AI agents (MCP)** (`ai:connect`) | Connect an MCP client such as Claude Code, once an administrator has turned MCP on. |

Either way, the assistant or agent can only do what the person could do themselves. Configuring AI
needs **Configure the instance**.

## Service accounts

Service accounts can use the assistant without a person: through the API, or over MCP. Because nobody
approves their changes one by one, each account has its own **AI access** — off, read only, or read and
write with an optional cap on writes — set from its row menu in **Settings → Service accounts**. See
[AI assistant — setup](/help/ai-assistant-setup#service-accounts) and
[Service accounts](/help/users-permissions-service-accounts).
