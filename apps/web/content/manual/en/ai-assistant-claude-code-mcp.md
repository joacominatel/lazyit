---
title: Claude Code & MCP
order: 1
category: ai-assistant
subcategory: claude-code-mcp
---

# Claude Code & MCP

lazyit can be used from **Claude Code** and any other AI app that speaks the **Model Context Protocol
(MCP)** — Cursor, VS Code, OpenAI Codex and others. The app connects to your lazyit instance and works
**as you**: it sees what your role can see, can only do what your role allows, and every change it makes
is recorded under your name, noted as made through an AI app.

The **Claude Code plugin** installs two pieces at once:

- **The MCP server** — lazyit's tools (look up assets, users, access, articles; create and change
  records) exposed to the app.
- **The lazyit skill** — a short guide that teaches Claude what lazyit is and how to use it well.

## Before you start

- An administrator must turn on **External AI agents (MCP)** in **Settings → AI**. It is independent of
  the in-app chat: it works with no AI provider configured.
- Your role needs **Connect external AI agents (MCP)** (`ai:connect`). Administrators and Members have
  it by default.

Open the **user menu** (your avatar, top right) → **AI & connected apps** (`/account/ai`). The page says
which way apps connect on your instance, and shows the exact commands to copy.

## Before you connect: what you are trusting

Over MCP, **lazyit shows no approval cards**. The app, and the model behind it, decide what to call —
and **the app decides whether to ask you first**. Read this before connecting one:

- **Your data goes to the app's AI provider.** Everything the app reads from lazyit — any record you can
  see — is sent to the model the app uses, under the terms of your own account with it. lazyit has no
  say over that provider's retention or training.
- **Keep the app's confirmations on.** Most clients ask before running a tool that changes data; lazyit
  marks its tools honestly as reading, changing or destructive so they can. If you turn that off (an
  "auto-approve" or "yolo" mode), a change runs the moment the model decides to make it.
- **Text in lazyit can try to steer the model.** An article, a note or a description written by someone
  else may contain instructions aimed at an AI. Combined with other MCP servers in the same session that
  can **fetch web pages, send email or post messages**, such an instruction could make the model send
  your lazyit data elsewhere. Don't combine lazyit with those servers in a session where you don't review
  each call.
- **Grant the least access.** Choose **Read only** unless you need the app to change things. **Admin
  actions** — roles, access grants, sign-in and other sensitive changes — are never preselected and ask
  for your password; grant them only for a task that needs them, then revoke.
- **Revoke what you don't use**, on [Connected apps](/help/ai-assistant-connected-apps).

A service account connected over MCP has no one to ask at all; its administrator bounds it with
[AI access and a write cap](/help/ai-assistant-setup#service-accounts).

## How apps connect: OAuth or personal tokens

lazyit picks the method from the instance's configured public address (`WEB_ORIGIN`); the page shows which
one applies.

| The instance is configured with | Apps connect with | What you do |
| --- | --- | --- |
| an **HTTPS** address | **OAuth sign-in** | The app opens lazyit in your browser; you approve it on a consent screen. No token to copy. |
| no HTTPS address (for example **plain HTTP**, LAN mode) | **Personal tokens** | You [create a token](/help/ai-assistant-connected-apps#personal-tokens) and give it to the app. |

**Why no OAuth on plain HTTP?** OAuth sends one-time codes and tokens between your browser, the app and
lazyit. Unencrypted, anyone on the network could read them, and AI apps refuse to sign in over plain HTTP.
If the page says you're on HTTPS but still uses personal tokens, the instance isn't configured with its
HTTPS address — an administrator sets `WEB_ORIGIN`; see
[Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls).

**Cloud connectors** (claude.ai, Claude Desktop connectors, ChatGPT) connect from the provider's servers,
so they only work when your instance is **reachable from the internet over HTTPS** with a publicly trusted
certificate. Desktop and command-line apps — Claude Code, Cursor, VS Code — only need to reach lazyit from
your computer.

## Install in Claude Code (HTTPS instances)

1. Copy the two commands from **AI & connected apps** and run them in a terminal. They look like this:

   ```
   claude plugin marketplace add https://lazyit.example.com/api/ai/claude-code/marketplace.json
   claude plugin install lazyit@lazyit-lazyit-example-com
   ```

   The marketplace is named after your instance's address, so several instances can sit side by side.
   The commands always use the instance's **configured** address: if you opened lazyit at another one
   (an internal name or an IP), the page warns you and shows them for review instead.
2. Start Claude Code, run `/mcp`, choose **lazyit** and sign in. Your browser opens the
   [consent screen](#the-consent-screen).
3. **Updates are not automatic by default.** Open `/plugin` in Claude Code → **Marketplaces**, select your
   lazyit marketplace and enable auto-update.

**On a `localhost` instance** (`localhost`, `127.0.0.1`, `::1`), Claude Code refuses a marketplace on a
loopback address, so the page hides those commands and starts with the
[download](#install-from-a-download-any-instance).

**Internal certificate authority.** If the instance's certificate comes from a company CA, Claude Code
(and other Node.js-based apps) must trust it before starting:

```
export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem
```

## Install from a download (any instance)

The only way on a plain-HTTP instance, and an alternative on HTTPS.

1. On **AI & connected apps**, click **Download plugin (.zip)**. It is built for your instance and
   contains **no token**.
2. Unzip it into your Claude Code skills folder:

   ```
   mkdir -p ~/.claude/skills/lazyit
   unzip -o lazyit-plugin.zip -d ~/.claude/skills/lazyit
   ```

   Claude Code loads it in your **next session** as the plugin `lazyit@skills-dir`. To try it for one
   session only, run `claude --plugin-dir ./lazyit-plugin.zip`. To update, download and unzip again over
   the same folder.
3. Connect:
   - **HTTPS:** start Claude Code and run `/mcp` to sign in.
   - **Plain HTTP:** [create a personal token](/help/ai-assistant-connected-apps#personal-tokens) first.
     Claude Code asks for it when you enable the plugin and keeps it in your system's keychain — never in
     the plugin files.

## Other MCP clients

The **Other MCP clients** card shows the MCP server address (`https://<your-instance>/mcp`) and
ready-made configuration for **Claude Code** (server only, without the skill), **Cursor**, **VS Code** and
any other client:

- **HTTPS:** only the address is needed. The client discovers lazyit's sign-in and opens the consent
  screen in your browser.
- **Plain HTTP:** the client sends your personal token in an `Authorization: Bearer …` header. Replace
  the `YOUR_PERSONAL_TOKEN` placeholder with your token; the VS Code snippet asks for it when the server
  starts, so it is never written to the file.

Never put a token in the address (`?token=…`): lazyit refuses it and **revokes that token on sight**.
Keep configuration files that hold a token out of shared repositories.

## The consent screen

When an app signs in with OAuth, lazyit shows a consent screen before anything is granted:

- **The app's name** — **Verified** when the app identifies itself by a published address that is on
  your instance's list of allowed apps (Claude Code is, out of the box); otherwise **Not verified**, and
  the name is only what the app says about itself.
- **The app's domain** — for an app that publishes its details at a web address (Claude Code does, at
  `claude.ai`), lazyit fetches them from there and shows **Domain: claude.ai**. An app can show a domain
  and still be **Not verified**: it proved where its details come from, but it isn't on your list.
- **Where you'll return to** — the address the app receives its sign-in at, in large type. **This is the
  real trust signal**: for a desktop app it is usually `localhost` or `127.0.0.1` (your own computer).
- **The account it acts as**, and **what it may do** — **Read only** or **Read & write** (preselected
  when the app asked for it).
- **Admin actions**, only if the app asked. Never preselected; ticking them asks for your password. After
  five wrong passwords lazyit makes you wait before trying again ("Too many attempts"), and the wait is
  shared with password confirmations in the AI chat.

Choose **Allow access** or **Deny**. For an app that is **not verified**, lazyit asks you to confirm a
second time: continue only if you started the connection yourself, just now, and you recognize where it
sends you (and its domain). lazyit never forwards you without a click, and it asks every time.

If the screen says the app **isn't allowed**, or that it asked for an address it didn't register, lazyit
stops and sends you nowhere — see
[Troubleshooting](/help/ai-assistant-troubleshooting#the-consent-screen-says-the-app-isnt-allowed).

### How lazyit recognizes an app

Some apps — Claude Code among them — identify themselves by an **HTTPS address** where they publish their
name and sign-in addresses. lazyit reads that description when you connect and remembers it for up to a
day, so the details come from the publisher, not from the app. It reads it only from public internet
addresses, follows no redirects, and refuses a description that doesn't match its address.

- **No internet access on your lazyit server?** Claude Code still connects: lazyit ships a copy of Claude
  Code's description and uses it when the real one can't be fetched. Other apps that identify themselves
  this way need lazyit to reach their address.
- **Apps that register themselves** instead (most other MCP clients) don't need this.

The administrator's list of allowed apps in **Settings → AI** applies either way.

## What happens next

- The first time an app uses a new connection, lazyit notifies you (and emails you, when email is
  configured), linking to **AI & connected apps** where you can
  [revoke it](/help/ai-assistant-connected-apps).
- The app refreshes its sign-in by itself. If it goes unused for 30 days, it asks you to sign in again.
- Something not working? See [Troubleshooting](/help/ai-assistant-troubleshooting#external-ai-agents-mcp).
