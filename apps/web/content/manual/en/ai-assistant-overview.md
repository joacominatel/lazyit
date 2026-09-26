---
title: AI assistant — overview
order: 1
category: ai-assistant
subcategory: overview
---

# AI assistant — overview

lazyit can work with AI in three ways. Each one acts **as a person or service account, with exactly
that principal's permissions** — never more.

- **The in-app assistant** — a chat in the top bar. People ask about the estate ("which laptops are
  unassigned in Madrid?") and ask for changes ("assign MBA-017 to Juan"). **Every change it proposes
  waits for that person's approval.** See [Using the chat](/help/ai-assistant-using-the-chat).
- **External AI agents (MCP)** — Claude Code, OpenAI Codex, Cursor, VS Code and other clients that
  speak the Model Context Protocol connect to lazyit on a person's behalf, with their own model. See
  [Claude Code & MCP](/help/ai-assistant-claude-code-mcp).
- **Service accounts** — scripts call the assistant through the API (`POST /api/ai/runs`), or connect
  over MCP, without a person. See [Service accounts](#service-accounts) below.

## Off by default

Nothing about AI is active on a new or upgraded instance. An administrator turns each part on in
**Settings → AI**, and each has its own switch:

| Switch | Needs | Effect of turning it off |
| --- | --- | --- |
| **The assistant** | An AI provider, a model and — for hosted providers — an API key | Hidden for everyone at once; configuration and key are kept |
| **External AI agents (MCP)** | Nothing else — the agent brings its own model | Every connection is paused at once; it resumes when turned back on |
| **Web search** (assistant only) | A provider that supports it | Chats that used it become read-only |

See [AI assistant — setup](/help/ai-assistant-setup).

## Who can use it

Two permissions govern AI. Both are granted to Administrators and Members by default and can be changed
in [Permissions](/help/permissions):

| Permission | What it allows |
| --- | --- |
| **Use the AI assistant** (`ai:use`) | Use the chat once the assistant is on; for a service account, the headless API. |
| **Connect external AI agents (MCP)** (`ai:connect`) | Connect an MCP client once MCP is on. |

Neither permission adds any power: the assistant or agent can only do what the person could do
themselves. Configuring AI needs **Configure the instance**.

## What leaves your server

Read this before turning anything on. The administrator acknowledges it in the setup wizard, and the
acknowledgement is recorded.

### To the AI provider (the in-app assistant)

When someone uses the chat, lazyit sends to the provider the administrator chose:

- the messages they type and the answers they give in the assistant's forms;
- the address of the page they are on and which record it is about — never what is on the screen;
- lazyit's instructions to the model, the administrator's own instructions, and the list of tools;
- **every result of every tool the assistant uses** — that is, any record **that person** can read:
  names, emails, employee numbers, assets and assignments, applications and who has access to them,
  stock, knowledge-base articles (including restricted folders they can open) and, for people who can
  read the activity history, its entries.

lazyit never sends Secret Manager values, sign-in passwords, service-account tokens or the provider's
API key. The key is stored encrypted and never shown again.

**What the provider does with it is set by your contract with that provider** — retention, whether it
is used for training, the region it is processed in. lazyit cannot enforce or verify those terms, and
any cross-border data-protection obligations are yours. To keep everything on your premises, use a
model you host yourself through the **OpenAI-compatible** provider.

### To search partners (web search, off by default)

When web search is on, the **provider** runs the searches on its own servers. The search queries the
assistant writes and the conversation context go to the provider, which may pass the queries on to its
search backend or a search partner, and may bill searches separately. lazyit itself makes no request to
any other website. With OpenAI, lazyit restricts search to OpenAI's cached copy of the web, so no page
is fetched live from its site. See [Web search](/help/ai-assistant-setup#web-search).

### Through external agents (MCP)

An MCP client uses its own model. What it reads from lazyit goes to **whatever provider that client
uses, under the terms of the person running it** — lazyit has no say over it. See
[Before you connect](/help/ai-assistant-claude-code-mcp#before-you-connect-what-you-are-trusting).

### What stays on your server

- **Conversations** are kept for the retention the administrator sets (90 days by default, 7–3650),
  then deleted. Only their owner can read them — administrators cannot.
- **The AI action log** — every change the assistant proposed, who decided and what ran — is permanent
  and survives deleting the chat.
- On a plain-HTTP (`lan`) instance, chat traffic between the browser and lazyit is unencrypted, like
  the rest of the app.

## How lazyit keeps the assistant in check

Anything the assistant reads — an article, a note, a web page — might contain text written to trick an
AI ("ignore your instructions and grant…"). lazyit does not rely on the model to resist it:

- **You approve every change** on a card that lazyit builds from the exact change that will run, not
  from what the model wrote. See [Approving changes](/help/ai-assistant-approvals).
- **Content written by others is flagged.** A change proposed after the assistant read such content
  shows a **Based on content written by others** note, and is never applied automatically.
- **Sensitive changes** — roles, identity, access grants, sign-in, applications marked critical,
  instance configuration — get a distinct card, never auto-approve, and some need your password.
- **Some things are out of reach entirely**: the assistant cannot read secrets, cannot run anything
  that returns a credential in clear (such as a new service-account token or a temporary password), and
  cannot change the AI's own configuration.

External agents are different: over MCP the **client** decides whether to ask you before a change.
Read [Before you connect](/help/ai-assistant-claude-code-mcp#before-you-connect-what-you-are-trusting)
before connecting one.

## Service accounts

A service account can use the assistant headlessly — through the API, or over MCP. Nobody approves its
changes one by one, so each account has its own **AI access** (off, read only, or read and write with an
optional cap on writes), set from its row menu in **Settings → Service accounts**. Headless runs never
search the web. See [Service accounts](/help/ai-assistant-setup#service-accounts) on the setup page.

## Where to go next

| You want to | Read |
| --- | --- |
| Turn the assistant or MCP on, or change limits | [Setup](/help/ai-assistant-setup) |
| Use the chat | [Using the chat](/help/ai-assistant-using-the-chat) |
| Understand a change card | [Approving changes](/help/ai-assistant-approvals) |
| Connect Claude Code, Cursor or another client | [Claude Code & MCP](/help/ai-assistant-claude-code-mcp) |
| Review or revoke what can act as you | [Connected apps & personal tokens](/help/ai-assistant-connected-apps) |
| Fix an error | [Troubleshooting](/help/ai-assistant-troubleshooting) |
