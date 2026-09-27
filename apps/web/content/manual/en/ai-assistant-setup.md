---
title: AI assistant — setup
order: 1
category: ai-assistant
subcategory: setup
---

# AI assistant — setup

Everything about AI is configured in **Settings → AI**, which needs the **Configure the instance**
permission. The page has five cards:

1. **The provider** — a setup wizard while the assistant is off, the **Provider & model** editor once it
   is on.
2. **Behaviour & limits** — retention, budgets and the assistant's instructions.
3. **Web search** — off by default.
4. **External AI agents (MCP)** — its own switch, the endpoint, and the allowed clients.
5. **Turn off the AI assistant** — shown while it is on.

Next to each setting, the **?** explains it (hover, or click, tap or press Enter to keep it open; Escape
closes it). Most tips end with **Learn more in the Manual**, which opens the matching section of this
page; **Setup guide** at the top of Settings → AI opens this page too.

Before you turn anything on, read
[What leaves your server](/help/ai-assistant-overview#what-leaves-your-server).

## Before you start: `AI_SECRET_KEY`

Provider API keys are stored encrypted with a key of their own: the `AI_SECRET_KEY` environment variable
of the API service. A fresh install and `start.sh --reconfigure` write it for you. To add it by hand,
generate one with `openssl rand -hex 32`, set it, restart the API, and back it up with the rest of your
environment file.

Until it is set, Settings → AI says so at the top, no API key can be saved, and only a keyless
OpenAI-compatible server can be used. MCP does not need it. Losing it only means typing the provider
key again.

## The setup wizard

While the assistant is off, Settings → AI walks you through five steps. Each step saves what you entered
(still off), so you can stop and come back — the wizard reopens where you left it.

1. **Provider** — Anthropic, OpenAI, Google Gemini, or **OpenAI-compatible**: any server that speaks the
   OpenAI API, such as a model you host or a gateway.
2. **Credentials** — the provider's API key. It is stored encrypted and **never shown again**, not even
   to administrators. For an OpenAI-compatible server you also give its **base URL** (usually ending in
   `/v1`); see [Private-network servers](#private-network-servers).
3. **Model** — pick a suggestion or type any model id your provider accepts, and optionally the
   **reasoning effort** (higher answers harder requests better, but is slower and uses more tokens). For
   an OpenAI-compatible server you can also set a **temperature** between 0 and 2.
4. **Test** — lazyit checks that the provider accepts the key, knows the model, and that the model can
   **call tools**. The assistant cannot work without tool calling, so you cannot continue until the test
   passes. A failure says why; see [Troubleshooting](/help/ai-assistant-troubleshooting#the-connection-test-fails).
5. **Enable** — review what leaves your server, confirm you may send it to the provider, and select
   **Turn on the AI assistant**. The page reloads; people with **Use the AI assistant** see the chat in
   the top bar within a minute, or on their next reload.

lazyit tests the connection again at the moment you turn it on: if it fails then, nothing changes.

## Changing the provider, model or key

Once the assistant is on, **Provider & model** replaces the wizard. Switch provider, change the model or
its extras, or type a new key to replace the stored one; **Test these settings** tries your changes first.
Every change to the connection is tested again when you save — if the test fails, nothing is stored and
the assistant keeps working with the previous settings.

- Changing the **provider** or the **base URL** discards the stored key (a key belongs to one
  destination), so type the key for the new destination in the same save.
- Changing the **provider** makes every existing chat read-only. Changing the **default model** makes
  read-only only the chats that used the default; chats where the person chose a model keep working.
  People start a new chat to go on.

## Private-network servers

For a model you host yourself, choose **OpenAI-compatible** and give its address on your network. Turn
on **Server on a private network** to allow a private address (10.x, 172.16–31.x, 192.168.x, or an
internal name that resolves to one); only then is a plain `http://` address accepted — and then the key
and the prompts cross your network unencrypted.

Always refused: `localhost` and other loopback addresses (from inside the API container they point at
the container itself), link-local and cloud-metadata addresses. For a model on the Docker host itself,
see the deployment runbook's note on `host.docker.internal`. The base URL may not contain a user name,
password, query string or fragment — the key goes in the API key field.

## Behaviour & limits

These apply to every conversation, whether the assistant is on or off, and take effect on the next
request.

| Setting | Default | What it does |
| --- | --- | --- |
| Keep conversations for | 90 days | Older conversations are deleted automatically (7–3650 days). The AI action log is kept regardless. |
| Approval cards expire after | 30 minutes | A proposed change — or a question form — nobody answers in time can no longer be approved. |
| Daily token budget per person | 2,000,000 | The most tokens one person or service account may use in any 24 hours. Turn it off for no budget. |
| Max reply length | — | The longest single answer. |
| Max steps per request | — | How many tool calls one request may chain. |
| Conversation size limit | — | Past it, the chat becomes read-only and the person starts a new one. |
| Instructions for the assistant | — | Your own guidance added to lazyit's for every conversation (house conventions, preferred language). It cannot widen what the assistant may do, and it is sent to the provider. |

## Web search

**Allow the assistant to search the web** lets the chat look things up on the internet when lazyit's own
records and knowledge base don't have the answer — for example, the documentation of a third-party product
someone asks it to set up a workflow for. It is **off** by default.

- **What leaves.** The provider runs the search; the queries and the conversation context go to it, and
  possibly on to a search partner. Searches may be billed separately. Check your provider contract first.
  See [What leaves your server](/help/ai-assistant-overview#to-search-partners-web-search-off-by-default).
- **Which providers.** Anthropic, OpenAI, and Google Gemini 3 or later. The OpenAI-compatible provider
  and older Gemini models have none that works together with lazyit's tools; the switch is then disabled
  and the card says why.
- **Chat only.** Headless runs never search, because their changes run without anyone approving them.
  MCP clients search with their own tools, if any.
- **Results are untrusted.** Once the assistant has searched the web in a conversation, **nothing in
  that conversation is auto-approved anymore** — every change shows its card, even with auto-approve on.
- **OpenAI** searches its cached and indexed copy of the web, not live pages, so very recent pages may be
  missing. Its search can also "open" a page; that cannot be turned off, but the page comes from the
  cache, not from its site.
- **Searches per step** (default 5, 1–20) caps the searches in one model step, where the provider
  supports a limit (Anthropic).
- **Applies to new conversations.** Turning it off makes the chats that had it read-only.

Your provider account can also disable web search on its side (Anthropic: the organization's privacy
settings in the Claude Console; OpenAI: the organization's or project's tool permissions). If it is off
there while this switch is on, chats that have web search fail — see
[Troubleshooting](/help/ai-assistant-troubleshooting#web-search-is-disabled-at-the-provider).

## External AI agents (MCP)

**Allow external AI agents** lets MCP clients such as Claude Code connect to lazyit as the person who
connects them (who also needs **Connect external AI agents (MCP)**). It is independent of the assistant:
it works with no provider configured and does not need `AI_SECRET_KEY`. Turning it off disconnects every
client at once; their authorizations work again when you turn it back on.

The card shows:

- **The MCP endpoint** — the address for a client set up by hand: the API's `WEB_ORIGIN` followed by
  `/mcp`. When no `WEB_ORIGIN` is pinned, the card shows this page's address and says so; clients on
  other machines may need the instance's network address instead.
- **How clients sign in on this instance**, decided by `WEB_ORIGIN` — not by whether this page happens to
  be shown over HTTPS:

  | `WEB_ORIGIN` | Clients sign in with |
  | --- | --- |
  | an `https://` address | **OAuth** — the client opens a lazyit consent page in the browser; nothing to copy. |
  | anything else (for example the plain-HTTP `lan` mode) | **Personal tokens** each person creates on **Account → AI & connected apps**. |

  Putting a TLS proxy in front of lazyit is **not** enough on its own: set `WEB_ORIGIN` to the
  `https://` address people use and restart the API to switch to OAuth. If your certificate comes from an
  **internal certificate authority**, Node.js clients such as Claude Code must be started with it
  (`NODE_EXTRA_CA_CERTS`).
- **The Install in Claude Code steps** — the same as on **Account → AI & connected apps**.

**Cloud connectors** — claude.ai, Claude Desktop connectors and ChatGPT — connect from the provider's
servers, so they only work when the instance is reachable from the internet over HTTPS with a publicly
trusted certificate. Desktop and command-line clients only need to reach lazyit from the person's
computer. The person-side steps are in [Claude Code & MCP](/help/ai-assistant-claude-code-mcp).

### Allowed clients

Two things in the MCP card decide which clients may connect:

- **Accept any client with an https:// callback — on by default.** Any MCP client whose sign-in callback
  is an `https://` address may *ask* a person for access, even if it is not listed. That alone grants
  nothing: the person still sees the consent page, which shows the callback host and warns about an
  unverified client. It never admits a loopback callback (`http://127.0.0.1/…`) or an app-scheme callback
  such as `cursor://…` — those need a list entry. **Turn it off to accept only listed clients.**
- **The list.** lazyit ships **built-in clients** — Claude Code, OpenAI Codex, OpenCode, Gemini CLI,
  Cursor, VS Code / GitHub Copilot, claude.ai, Claude Desktop and ChatGPT — each with its identifier and
  how that identifier was checked (**Verified** from the client's own code or documentation, or **Vendor
  docs**). **Remove** a built-in client to stop it connecting, and **Restore** it at any time. Pi,
  Windsurf and Zed are not built in, because their identifiers could not be verified — add them yourself.
  A built-in client you removed that a later lazyit version no longer ships is listed under **Removed
  clients no longer in the built-in list**; restoring it only clears your removal.

**Add a client** by one of:

- its **client-metadata URL** — the `https://` URL the client uses as its client id; or
- its **callback address** — the exact address it sends people back to after sign-in: `https://…`, a
  loopback address such as `http://127.0.0.1/callback` (any port matches), or an app scheme such as
  `com.example.app:/callback` or `cursor://…`.

A client is recognized only this way — never by the name it gives itself. Plain `http://` is accepted
only on a loopback address, an address with a user name (`…@…`) is always refused, and app schemes are
accepted only as explicit entries. You can add up to 100 clients.

On the consent page, a client is shown as **Verified** only when it identifies itself by a
client-metadata URL **and** that URL is on this list — see
[The consent screen](/help/ai-assistant-claude-code-mcp#the-consent-screen).

## Service accounts

Service accounts use AI headlessly — through the API (`POST /api/ai/runs`) or over MCP — and nobody
approves their changes one by one. In **Settings → Service accounts**, open an account's row menu and
choose **AI access**:

- **Off** — no AI use at all: headless runs and MCP are refused.
- **Read only** — the assistant may only read.
- **Read and write** — it may also make changes within the account's permissions. The default for an
  account never configured.
- **Limit writes** (read and write only) — caps the changes per headless run and, since MCP has no runs,
  per rolling hour over MCP. **Every record counts**: a batch that updates 20 assets is 20 changes
  (skipped rows don't count), and a batch larger than what is left under the cap is refused whole, with
  nothing changed.

AI access only narrows what the account's permissions allow; it never grants one. The account also needs
**Use the AI assistant** for headless runs and **Connect external AI agents (MCP)** for MCP. An account
holding **Report server inventory (agent)** — the agents' reporting credential — is refused AI use
whatever you choose; create a separate account for AI. See also
[Service accounts](/help/users-permissions-service-accounts).

## Turning it off

**Turn off the assistant** (at the bottom of the page) hides it for everyone and refuses new requests at
once. Conversations are kept and still deleted when their retention ends; changes waiting for approval
cannot be approved while it is off. The provider, model and encrypted key are kept, so turning it back on
is a single step. External AI agents are not affected — they have their own switch.

## After a lazyit update

An update that changes the assistant's tools or instructions makes the chats started before it
**read-only**; people start a new chat to go on. Nothing else needs doing — settings, keys, connected
apps and personal tokens carry over.
