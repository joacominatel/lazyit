---
title: AI assistant — troubleshooting
order: 1
category: ai-assistant
subcategory: troubleshooting
---

# AI assistant — troubleshooting

Each entry goes **symptom → cause → fix**. Messages are quoted as lazyit shows them in English; the
Spanish interface says the same in Spanish. Errors never include the provider's own response — lazyit
keeps it out on purpose, so the key and your data never end up in a message or a log.

## Setting up the assistant

### The connection test fails

The test in the setup wizard and in **Provider & model** checks the key, the model and tool calling.

| The test says | Cause | Fix |
| --- | --- | --- |
| The provider rejected the key | Wrong, revoked or inactive key, or a key not allowed to use this model. | Create or check the key at the provider and type it again. |
| The provider is rate-limiting this key | Too many requests on this key right now. | Wait a moment and test again. |
| The provider could not be reached or did not answer in time | Network path from the API server, a firewall, or a provider outage. | Check that the API container can reach the provider over HTTPS, then test again. |
| The provider refused the request | Usually an unknown model id, or a setting this model does not support (an effort or temperature). | Check the model id at the provider; clear the extras. |
| lazyit refused to connect to this address | The base URL is not a public host, or it is private and **Server on a private network** is off — or it is loopback, link-local or cloud metadata, which is never allowed. | Turn on **Server on a private network** for a LAN server; use the server's network address, never `localhost`. See [Private-network servers](/help/ai-assistant-setup#private-network-servers). |
| The model answered but did not call a tool | The model has no tool calling, or the server has it disabled. | Pick a model with tool calling (on a self-hosted server, enable it in the server's configuration). |
| This build of lazyit cannot reach AI providers | The instance is older than the assistant. | Update lazyit. |

### The page says "The server has no AI_SECRET_KEY"

**Cause:** the API has no `AI_SECRET_KEY`, so no provider key can be stored. **Fix:** set it
(`openssl rand -hex 32`) and restart the API — see
[Before you start](/help/ai-assistant-setup#before-you-start-ai_secret_key). A keyless OpenAI-compatible
server works without it.

If the key **changed** (for example after restoring an environment file from another host), the stored
provider key no longer decrypts and the assistant becomes unavailable. Type the provider key again in
**Provider & model**.

### The assistant can't be turned on

| Message | Cause | Fix |
| --- | --- | --- |
| Acknowledge what leaves this server… | The disclosure box in the last wizard step is not ticked. | Read it and tick it. |
| Changing the provider or the base URL discarded the stored key… | A key belongs to one destination. | Type the key for the new provider or URL in the same save. |
| The connection test failed, so nothing was changed | lazyit tests again when you turn it on. | Fix what the test result says (table above). |
| This instance runs with authentication disabled (AUTH_MODE=shim) | A development mode where AI is never available. | Run the instance with a real sign-in mode. |
| Someone else changed the AI settings meanwhile | Two administrators saved at once. | Reload and save again. |

### Web search is disabled at the provider

**Symptom:** with **Allow the assistant to search the web** on, chats fail with *"The AI provider refused
web search because it is disabled for this account."*

**Cause:** your provider account has web search turned off on its side (Anthropic: the organization's
privacy settings in the Claude Console; OpenAI: the organization's or project's tool permissions).

**Fix:** enable web search at the provider — or turn the switch off in **Settings → AI**. Chats that had
web search become read-only; people start a new chat.

If the **switch is disabled**, the card says why: the provider has no native web search (OpenAI-compatible)
or the model can't search together with lazyit's tools (Gemini older than 3).

## The chat

### The chat doesn't appear

- The assistant is off — an administrator turns it on in **Settings → AI**.
- Your role lacks **Use the AI assistant** — see [Permissions](/help/permissions).
- It was just turned on — it appears within a minute, or reload the page.

### Chat messages

| The chat says | Cause | Fix |
| --- | --- | --- |
| The AI provider rejected the credentials | The stored key was revoked or expired at the provider. | An administrator types a new key in **Settings → AI**. |
| The AI provider is busy | The provider is rate-limiting (your key or its own load). | **Try again** after the time shown. |
| The AI provider isn't responding right now | Outage, network problem, or a very slow answer. | **Try again**; if it persists, check the provider's status page and the API's network path. |
| The AI provider couldn't process this request | The provider rejected the request — often a model it no longer serves, or one the person typed that doesn't exist. | Start a new chat with another model; an administrator checks the default model. |
| The AI provider declined to answer this | The provider's own content filter stopped the answer. | Rephrase the request. |
| lazyit isn't allowed to reach the AI provider | The provider address is refused by lazyit's network rules. | An administrator checks the base URL and **Server on a private network**. |
| The AI provider refused web search because it is disabled for this account | See [Web search is disabled at the provider](#web-search-is-disabled-at-the-provider). | |
| The daily AI budget has been reached | You used your tokens for the last 24 hours. | Wait, or ask an administrator to raise the budget. |
| This conversation is too long to continue | The conversation reached the size limit. | **Start a new chat**. |
| The assistant stopped after too many steps | The request needed more tool calls than **Max steps per request** allows. | Split it into smaller requests, or an administrator raises the limit. |
| This chat used an earlier AI configuration and is read-only | See [This chat is read-only](#this-chat-is-read-only). | **Start a new chat**. |
| Another window is already answering in this chat | The chat is open in another tab or device. | The chat shows that answer; wait for it. |
| Connection lost | The browser lost its connection to lazyit. | **Reconnect**. The answer kept going on the server. |
| The answer was interrupted by a restart | The API restarted mid-answer. | Send the message again. |
| Too many requests | You sent many messages in a short time. | Wait a moment. |
| The AI assistant was turned off | An administrator turned it off. | Nothing to do; waiting changes can't be approved. |
| You no longer have access to the assistant | Your role lost **Use the AI assistant**, or your account changed. | Ask an administrator. |

### This chat is read-only

A chat stops accepting messages when an administrator changed the provider or the default model it used,
turned off web search that it had, when lazyit was updated with different tools or instructions, or when
it grew too long. You can still read and copy it (`/copy`); select **Start a new chat** to go on.

### Replies appear all at once, not as they are written

**Cause:** a reverse proxy or load balancer **in front of lazyit's Caddy** buffers or compresses the
chat's event stream. **Fix:** turn buffering and compression off for `text/event-stream` on that proxy
(nginx: `proxy_buffering off;` on the lazyit location). See
[Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls).

### The assistant gives up on something it tried twice

**Cause:** when the same tool call fails the same way twice in one answer, lazyit refuses to run it again
and tells the assistant to stop and explain what is blocking it, instead of looping. **Fix:** read what
it says — usually a missing record, a permission you don't have, or a value it needs from you — and
answer or rephrase.

## Change cards

### "The item changed since this was proposed"

**Cause:** someone edited the record between the proposal and your approval. Nothing was applied.
**Fix:** none needed — the assistant reads it again and can propose an updated change.

### "This change was updated since it was proposed"

**Cause:** the change's effects differ now — a warning was added, or an impact count moved (more assets
now use the category an archive would affect). Nothing was applied. **Fix:** review the points marked
**New** and decide again. See [When the card changes under you](/help/ai-assistant-approvals#when-the-card-changes-under-you).

### "Too many wrong passwords. Try again in …"

**Cause:** five wrong passwords in a row. lazyit locks further attempts for a time that grows with each
failure, from one second up to 15 minutes. The count is shared between chat cards and the MCP consent
screen. **Fix:** wait the time shown; the **Approve** button comes back by itself.

### "Password confirmation isn't available with your sign-in method"

**Cause:** your account signs in through your identity provider, with no lazyit password. **Fix:** make
that change from the item's own page.

### "5 changes couldn't be proposed" (or another number)

**Cause:** at most 5 changes can wait for approval in one step; the rest are held back on purpose.
**Fix:** decide the current ones — the assistant proposes the next batch by itself. Other reasons appear
under **Show details** (an invalid value, a permission you lack).

### Approve all skips some changes

**Cause:** by design, it never includes changes that need your password, *Sensitive changes*, or changes
whose last decision was refused. **Fix:** decide those on their own page. See
[Several changes at once](/help/ai-assistant-approvals#several-changes-at-once).

### A change was not auto-approved

**Cause:** auto-approve never covers critical changes, changes proposed after the assistant read free
text in the same turn (anyone's, including your own notes), or anything in a chat that searched the web.
**Fix:** approve it on its card. See [Auto-approve](/help/ai-assistant-approvals#auto-approve).

## External AI agents (MCP)

### Connecting a client

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/mcp` answers 404 | External AI agents (MCP) is off, or the instance runs in shim mode. | An administrator turns it on in **Settings → AI**. |
| 401 *"This instance uses OAuth for AI agents: personal tokens are not accepted"* | A personal token on an HTTPS instance (or one that moved from LAN mode to HTTPS). | Remove the header and let the client sign in. |
| On a plain-HTTP instance, Claude Code shows the server as `failed` or *needs authentication* | No personal token configured — there is no OAuth on plain HTTP. | Enable the plugin and paste a [personal token](/help/ai-assistant-connected-apps#personal-tokens), or add the server with `--header "Authorization: Bearer lzit_pat_…"`. For a scripted session, pass it with `--settings '{"pluginConfigs":{"lazyit@skills-dir":{"options":{"token":"lzit_pat_…"}}}}'` (mind your shell history). |
| Claude Code still says *needs authentication* after you added the header | Claude Code caches that state per server name. | `claude mcp remove lazyit`, then add it again — or authenticate from `/mcp`. |
| Claude Code shows `failed` on an HTTPS instance with a company CA | Node.js doesn't trust your certificate authority. | Start it with `NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem`. |
| `claude plugin install` fails: *"Archive URLs must use https:// and must not point at a loopback…"* | The instance's address is `localhost`. | [Install from a download](/help/ai-assistant-claude-code-mcp#install-from-a-download-any-instance) or use a real host name. |
| **AI & connected apps** says HTTPS but uses personal tokens | `WEB_ORIGIN` isn't an `https://` address. | An administrator sets it and restarts the API. |
| claude.ai, Claude Desktop connectors or ChatGPT can't connect | They connect from the provider's servers. | The instance must be reachable from the internet over HTTPS with a publicly trusted certificate. |
| 400 *"Send the token in the Authorization header, never in the URL."* | The token was put in the address, so lazyit revoked it. | Create a new token and send it in the header. |
| On plain HTTP, a client fails with *Unexpected token '<'* | It tried OAuth, and the instance's proxy configuration predates the fix that answers such probes cleanly. | Use a personal token; update lazyit to get a clear error. |
| Replies from an older client time out behind your own proxy | A proxy in front of Caddy buffers `text/event-stream`. | Don't buffer or compress event streams on that proxy. |

### The consent screen says the app isn't allowed

| The screen says | Cause | Fix |
| --- | --- | --- |
| **This app isn't allowed** | The app isn't registered, or isn't on the allowed list: an app-scheme or loopback callback not on the list, **Accept any client with an https:// callback** turned off, or a built-in client an administrator removed. | Start the connection again from the app; otherwise an administrator [adds the client](/help/ai-assistant-setup#allowed-clients) by its client-metadata URL or callback address. |
| **This request can't be trusted** | The app asked to send you to an address it didn't register. | Start again from the app. If it persists, the app's callback isn't the one on the list. |
| **App sign-in isn't available here** | The instance has no HTTPS `WEB_ORIGIN`. | Use a personal token instead. |
| **Connections for AI apps are off** | MCP is off. | An administrator turns it on. |
| **Your account can't connect AI apps** | Your role lacks **Connect external AI agents (MCP)**. | Ask an administrator. |

A client that registers itself (most do) and is refused shows the same: its registration fails with
`invalid_redirect_uri` when its callback is not allowed. The MCP Inspector, for example, needs its fixed
callback added by an administrator.

**An app that identifies itself by an HTTPS address** needs lazyit to fetch that address. With no internet
access on the server, only Claude Code still connects (lazyit ships a copy of its description); other such
apps are refused until the server can reach them. lazyit also limits how many of these fetches one person
can trigger in a short time.

### "Too many attempts" on the consent screen

**Cause:** wrong passwords for **Admin actions**; the lock is shared with password confirmations in the
chat. **Fix:** wait and try again, or untick **Admin actions** and allow the rest.

### Admin actions were unticked

**Cause:** your account signs in without a lazyit password, so admin actions can't be granted. **Fix:**
allow the rest; make admin-level changes in the app yourself.

### A connected app stopped working

Check, in order: you revoked it; your password changed or was reset (every connection ends); your
account was deactivated; MCP was turned off (connections are paused); a personal token expired; an OAuth
app wasn't used for 30 days; the instance moved from plain HTTP to HTTPS (personal tokens stop). See
[What ends a connection](/help/ai-assistant-connected-apps#what-ends-a-connection). Signing out of
lazyit is **not** a cause.

### A service account's run stops at its write cap

**Cause:** **Limit writes** in the account's AI access counts every record changed; a batch larger than
what is left is refused whole. **Fix:** raise the cap, or have the script send smaller batches. See
[Service accounts](/help/ai-assistant-setup#service-accounts).
