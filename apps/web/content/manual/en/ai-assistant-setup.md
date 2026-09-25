---
title: AI assistant — setup
order: 1
category: ai-assistant
subcategory: setup
---

# AI assistant — setup

Everything about AI is configured in **Settings → AI**, which needs the **Configure the instance**
permission. The page has five parts: the assistant's provider (a setup wizard while the assistant is
off, an editor once it is on), **Behaviour & limits**, **Web search**, **External AI agents (MCP)**,
and — once it is on — **Turn off the AI assistant**.

The page is kept to labels and controls. Next to a setting, the **?** opens its explanation: hover it
with a mouse, or click, tap or press Enter on it to keep it open (Escape closes it). Most tips end with
**Learn more in the Manual**, which opens the matching section of this page in a new tab; **Setup
guide** at the top of the page opens this page too.

## Before you start: `AI_SECRET_KEY`

Provider API keys are stored encrypted with a key of their own, the `AI_SECRET_KEY` environment
variable of the API service. Generate one with `openssl rand -hex 32`, set it, and restart the API.
Until it is set, Settings → AI says so at the top, no API key can be saved, and only a keyless
OpenAI-compatible server can be used. MCP does not need it.

## The setup wizard

While the assistant is off, Settings → AI walks you through five steps. Each step saves what you
entered (still turned off), so you can stop and come back — the wizard reopens where you left it.

1. **Provider** — Anthropic, OpenAI, Google Gemini, or **OpenAI-compatible**: any server that speaks
   the OpenAI API, such as a model you host on your network or a gateway.
2. **Credentials** — the provider's API key. It is stored encrypted and **never shown again**, not even
   to administrators; to change it you type a new one. For an OpenAI-compatible server you also give
   its **base URL** (usually ending in `/v1`); see [Private-network servers](#private-network-servers).
3. **Model** — pick a suggestion or type any model id your provider accepts (the test in the next step
   checks it), and optionally the **reasoning effort** — higher effort answers harder requests better,
   but is slower and uses more tokens. For an OpenAI-compatible server you can also set a
   **temperature** between 0 and 2; leave it blank for the server's default.
4. **Test** — lazyit checks that the provider accepts the key, knows the model, and that the model can
   **call tools**. The assistant cannot work without tool calling, so you cannot continue until the
   test passes. If it fails, the page says why (a rejected key, an unknown model, an unreachable host…).
5. **Enable** — review what leaves your server (the step lists it in short; **Exactly what is sent**
   opens [AI assistant — overview](/help/ai-assistant-overview#what-leaves-your-server)), confirm you
   may send it to the provider, and **Turn on the AI assistant**. The page reloads, and people with the
   **Use the AI assistant** permission see the assistant in the top bar — others within a minute or on
   their next reload.

lazyit checks everything again when you turn it on: if the connection test fails at that moment,
nothing changes and the page shows the test result.

## Changing the provider, model or key

Once the assistant is on, **Provider & model** replaces the wizard. You can switch provider, change the
model or the extras, or type a new key to replace the stored one; **Test these settings** tries your
changes before saving them. Any change to the connection is tested again when you save — if the test
fails, nothing is stored and the assistant keeps working with the previous settings.

Changing the **provider** or the **base URL** discards the stored key (a key belongs to one
destination), so type the key for the new destination in the same save.

## Private-network servers

For a model you host yourself, choose **OpenAI-compatible** and give its address on your network. Turn
on **Server on a private network** to allow a private address (10.x, 172.16–31.x, 192.168.x, or an
internal name that resolves to one); only then is a plain `http://` address accepted. Some addresses are
always refused: `localhost` and other loopback addresses (they would point at the API container itself),
link-local and cloud-metadata addresses. The base URL may not contain a user name, password, query string
or fragment — the key goes in the API key field.

## Behaviour & limits

These apply to every conversation and can be changed at any time, whether the assistant is on or off.
A change applies to new requests:

| Setting | Default | What it does |
| --- | --- | --- |
| Keep conversations for | 90 days | Older conversations are deleted automatically (7–3650 days). The record of executed actions is kept. |
| Approval cards expire after | 30 minutes | A proposed change nobody approves in time can no longer be approved. |
| Daily token budget per person | 2,000,000 | The most tokens one person or service account may use in any 24 hours. Turn it off for no budget. |
| Max reply length, max steps, conversation size | — | Bounds on a single answer, on how many tools one request may chain, and on how long a conversation may grow — past the size limit, the person starts a new chat. |
| Instructions for the assistant | — | Your own guidance, added to lazyit's for every conversation (house conventions, preferred language). It cannot widen what the assistant may do. The counter under the box shows how many characters are left. |

## Web search

**Allow the assistant to search the web** lets the chat look things up on the internet when lazyit's own
records and knowledge base don't have what it needs — for example, the documentation of a third-party
product someone asks it to set up a workflow for. It is **off** by default.

- **Where the search runs.** The AI provider runs the search on its own servers; lazyit makes no request of
  its own. The search queries and the conversation context go to the provider, which may pass the queries
  on to its search backend or a search partner, and may bill searches separately. Check your contract with
  the provider before you turn it on.
- **Which providers.** Anthropic, OpenAI, and Google Gemini 3 or later. The OpenAI-compatible provider and
  older Gemini models have no web search the assistant can use together with lazyit's tools; the switch is
  then disabled and the card says why.
- **Only the chat.** Headless runs (service accounts) never search the web, because their changes run
  without anyone approving them.
- **Results are treated as untrusted.** Web pages are written by anyone. The assistant treats them as
  information, never as instructions, and shows the pages it used under its answer. **Once it has searched
  the web in a conversation, nothing in that conversation is auto-approved anymore**: every change it
  proposes there shows its approval card, even when the person turned on auto-approve — the results stay
  in the conversation.
- **OpenAI.** lazyit runs OpenAI's search on its cached and indexed copy of the web, not on live pages, so
  very recent pages may be missing. OpenAI's search can also open pages; that can't be turned off, but it
  never fetches a page live from its site.
- **New conversations.** The switch applies to chats started after you change it. Turning it off makes
  the chats that had it read-only; people start a new chat to go on.
- **Searches per step** (default 5, 1–20) is the most searches the assistant may run in one step, where the
  provider supports a limit (Anthropic).
- **Disabled at the provider.** Your provider account can turn web search off on its side (Anthropic: the
  organization's privacy settings in the Claude Console; OpenAI: the organization's or project's tool
  permissions). If it is off there while the switch here is on, the provider refuses the request and the
  chat says *"The AI provider refused web search because it is disabled for this account."* Either enable
  web search at the provider, or turn **Allow the assistant to search the web** off here and start a new
  chat.

## External AI agents (MCP)

**Allow external AI agents** lets MCP clients such as Claude Code connect to lazyit, acting as the
person who connects them and with that person's permissions (they also need the **Connect external AI
agents (MCP)** permission). This switch is independent of the assistant: it works with no provider
configured. Turning it off disconnects every client at once; their authorizations work again when you
turn it back on.

The card shows the **MCP endpoint** — the address to give an MCP client that is set up by hand: the
public address in the API's `WEB_ORIGIN` followed by `/mcp`. When no address is pinned, the card shows
the address of the page you are on and says so; clients on other machines may then need the instance's
address on your network instead. The card also says, in one line, how
clients sign in on **this** instance. That depends on the API's `WEB_ORIGIN` setting — the public
address lazyit is pinned to — not merely on whether the page is shown over HTTPS:

- **`WEB_ORIGIN` is an `https://` address: OAuth.** The client opens a lazyit page in the browser where the person reviews the
  access and approves it — nothing to copy by hand, and each connection can be revoked from **Account →
  AI & connected apps**. If your certificate comes from an **internal certificate authority**, Claude
  Code and other Node.js clients must be started with it, for example
  `export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem`.
- **No `https://` `WEB_ORIGIN` (for example the plain-HTTP `lan` mode): personal tokens.** OAuth
  sign-in requires HTTPS and a fixed public address — otherwise the sign-in codes and tokens could travel
  unencrypted or to the wrong host — so it is not available. Each person creates a personal MCP token
  instead, and gives it to their client. Putting a TLS proxy in front of lazyit is **not** enough on its
  own: set `WEB_ORIGIN` to the `https://` address people use and restart the API to switch to OAuth.
- **Cloud connectors** — claude.ai, Claude Desktop connectors and ChatGPT — connect from the provider's
  servers, not from the person's computer, so they only work when your instance is reachable from the
  internet over HTTPS with a publicly trusted certificate.

While MCP is on, the card also shows the **Install in Claude Code** steps (the same as on **Account → AI &
connected apps**). Each person's connected apps and personal tokens are on that Account page.

### Allowed clients

Which clients may connect is decided by two things, both in the MCP card:

- **Accept any client with an https:// callback — on by default.** Any MCP client whose sign-in
  callback is an `https://` address may *ask* a person for access, even if it is not listed. This alone
  grants nothing: the person still sees the consent page, which shows the client's callback host and
  warns when a client was not listed. It never admits a loopback callback (`http://127.0.0.1/…`) or an
  app-scheme callback such as `cursor://…` — those need an entry. **Turn it off to accept only the listed
  clients.**
- **The list.** lazyit ships a list of **built-in clients** — Claude Code, OpenAI Codex, OpenCode, Gemini
  CLI, Cursor, VS Code / GitHub Copilot, claude.ai, Claude Desktop and ChatGPT — each shown with its
  identifier and how it was checked (**Verified** from the client's own code or documentation, or
  **Vendor docs**). **Remove** a built-in client to stop it connecting (while "any https:// client" is on,
  a removed client with an `https://` callback can still ask for consent), and **Restore** it at any
  time. Pi, Windsurf and Zed are not built in, because their identifiers could not be verified — add them
  yourself if your team uses them. If you removed a built-in client that a later version of lazyit no
  longer ships, it is listed under **Removed clients no longer in the built-in list**; restoring it only
  clears your removal.

To allow another client, **Add a client** by one of:

- its **client-metadata URL** — the `https://` URL the client uses as its client id; or
- its **callback address** — the exact address it sends people back to after sign-in: `https://…`, a
  loopback address such as `http://127.0.0.1/callback` (any port matches), or an app scheme such as
  `com.example.app:/callback` or `cursor://…`.

A client is recognized only this way — never by the name it gives itself. Plain `http://` is accepted
only on a loopback address, an address with a user name (`…@…`) is always refused, and app schemes are
accepted only as an explicit entry.

## Service accounts

Service accounts use the assistant headlessly — through the API or over MCP — and their changes are not
approved one by one. In **Settings → Service accounts**, open an account's row menu and choose
**AI access**:

- **Off** — no AI use at all for this account.
- **Read only** — the assistant may only read.
- **Read and write** — the assistant may also make changes within the account's permissions. This is
  the default for an account never configured.
- **Limit writes** (read and write only) — caps the changes per headless run and, since MCP has no runs,
  per rolling hour over MCP. Every record changed counts: a batch that updates 20 assets is 20 changes, and
  a batch larger than what is left under the cap is refused whole, with nothing changed.

AI access only narrows what the account's permissions allow; it never grants one. The account also
needs **Use the AI assistant** for headless runs and **Connect external AI agents (MCP)** for MCP. An
account holding **Report server inventory (agent)** — the agents' reporting credential — is refused AI
use whatever you choose; create a separate account for AI.

## Turning it off

**Turn off the assistant** (at the bottom of the page) hides it for everyone and refuses new requests.
Conversations are kept and still deleted when their retention ends; changes waiting for approval cannot
be approved while it is off. The provider, model and encrypted key are kept, so turning it back on is a
single step. External AI agents are not affected — they have their own switch.
