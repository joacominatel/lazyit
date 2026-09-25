---
title: Claude Code & MCP
order: 1
category: ai-assistant
subcategory: claude-code-mcp
---

# Claude Code & MCP

lazyit can be used from **Claude Code** and from any other AI app that speaks the **Model Context
Protocol (MCP)** — Cursor, VS Code, and others. The app connects to your lazyit instance and works
**as you**: it sees what your role can see and can only do what your role allows. Every change it makes
is recorded under your name like any other.

There are two pieces, and the **Claude Code plugin** installs both at once:

- **The MCP server** — lazyit's tools (look up assets, users, access, articles; create and change
  records) exposed to the AI app.
- **The lazyit skill** — a short guide that teaches Claude what lazyit is and how to use it well.

## Before you start

- An administrator must turn on the **MCP server** in **Settings → AI**. It is independent of the
  in-app chat: MCP works even when no AI provider is configured.
- Your role needs the **Connect external AI agents (MCP)** permission (`ai:connect`). Administrators and members have it
  by default.

Open the **user menu** (your avatar, top right) and choose **AI & connected apps**. The page lives at
`/account/ai`. It tells you, for your instance, which way apps connect and why — then shows the exact
commands to copy.

## How apps connect: OAuth or personal tokens

lazyit picks the method from how the instance is served. You don't choose it; the page shows which one
applies.

| Your instance is served over | Apps connect with | What you do |
| --- | --- | --- |
| **HTTPS** | **OAuth sign-in** | The app opens lazyit in your browser; you approve it on a consent screen. No token to copy. |
| **Plain HTTP** (LAN mode) | **Personal tokens** | You create a token in lazyit and give it to the app. |

**Why no OAuth on plain HTTP?** OAuth sign-in sends one-time codes and tokens between your browser, the
app and lazyit. Over unencrypted HTTP anyone on the network could read them, and AI apps refuse to sign
in over plain HTTP. So on a LAN instance lazyit switches OAuth off and offers personal tokens instead.
If the page says you're on HTTPS but still uses personal tokens, the instance isn't configured with its
HTTPS address — an administrator sets it (`WEB_ORIGIN`); see
[Reverse proxy & TLS](/help/deployment-operations-reverse-proxy-tls).

**Cloud connectors** (claude.ai, ChatGPT) connect from the provider's servers, not from your computer.
They only work when your lazyit instance is **reachable from the internet over HTTPS**. Desktop and
command-line apps — Claude Code, Cursor, VS Code — only need to reach lazyit from your machine, so they
work on an internal network too.

## Install in Claude Code (HTTPS instances)

1. Copy the two commands from **AI & connected apps** and run them in a terminal. They look like this:

   ```
   claude plugin marketplace add https://lazyit.example.com/api/ai/claude-code/marketplace.json
   claude plugin install lazyit@lazyit-lazyit-example-com
   ```

   The marketplace is named after your instance's address, so you can add several lazyit instances
   side by side. The commands always use the instance's **configured** address: if you opened lazyit
   at a different one (an internal name or an IP), the page warns you and shows the commands for
   review instead of as copy-ready.
2. Start Claude Code, run `/mcp`, choose **lazyit** and sign in. Your browser opens lazyit's
   [consent screen](#the-consent-screen).
3. **Updates are not automatic by default.** To receive new versions of the skill, open `/plugin` in
   Claude Code, go to **Marketplaces**, select your lazyit marketplace and enable auto-update.

**On a `localhost` instance** (an address like `localhost`, `127.0.0.1` or `::1`), install the plugin
from the [download](#install-from-a-download-any-instance) instead: Claude Code won't install a
marketplace from a loopback address. The install panel knows this — on such an instance it hides the
marketplace commands and starts with the download, with a note saying why.

**Internal certificate authority.** If your instance's HTTPS certificate is issued by a company CA,
Claude Code (and other Node.js-based apps) must be told to trust it before starting:

```
export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem
```

## Install from a download (any instance)

This is the only way on a plain-HTTP instance, and an alternative on HTTPS.

1. On **AI & connected apps**, click **Download plugin (.zip)**. The file is built for your instance and
   contains **no token**.
2. Unzip it into your Claude Code skills folder:

   ```
   mkdir -p ~/.claude/skills/lazyit
   unzip -o lazyit-plugin.zip -d ~/.claude/skills/lazyit
   ```

   Claude Code picks it up in your **next session** as the plugin `lazyit@skills-dir` — no marketplace
   and no install step. To try it for one session without installing, run
   `claude --plugin-dir ./lazyit-plugin.zip` instead. To update, download the plugin again and unzip it
   over the same folder.
3. Connect:
   - **HTTPS:** start Claude Code and run `/mcp` to sign in.
   - **Plain HTTP:** [create a personal token](/help/ai-assistant-connected-apps#personal-tokens) first.
     Claude Code asks for it when you enable the plugin and keeps it in your system's keychain — never
     in the plugin files.

## Other MCP clients

The page's **Other MCP clients** card shows the MCP server address (`https://<your-instance>/mcp`) and
ready-made configuration for **Claude Code** (server only, without the skill), **Cursor**, **VS Code**
and any other client:

- **HTTPS:** only the address is needed. The client discovers lazyit's sign-in by itself and opens the
  consent screen in your browser.
- **Plain HTTP:** the client sends your personal token in an `Authorization: Bearer …` header. The
  snippets contain the placeholder `YOUR_PERSONAL_TOKEN` — replace it with your token. The VS Code
  snippet asks for the token when the server starts, so it is never written to the file.

Snippets never contain a real token. Keep configuration files that hold a token out of shared
repositories.

## The consent screen

When an app signs in with OAuth, lazyit shows a consent screen before anything is granted. It shows:

- **The app's name** — marked **Verified** when the app is on your instance's list of known apps and
  lazyit confirmed it by the address it publishes itself at (Claude Code is, out of the box), or **Not
  verified** when the name is only what the app says about itself.
- **The app's domain** — for an app that publishes its details at a web address (Claude Code does, at
  `claude.ai`), lazyit fetches them from there and shows that domain next to the name, as
  **Domain: claude.ai**. The name is what the app says about itself; the domain is what lazyit checked.
  An app can show a domain and still be **Not verified** — it proved where its details come from, but
  it isn't on your instance's list — so read the domain before you allow it.
- **Where you'll return to** — the address the app receives its sign-in at, shown in large type. This is
  the real trust signal: for a desktop app it is usually `localhost` or `127.0.0.1` (your own computer).
  A website the app mentions is shown as unchecked text only.
- **The account it acts as**, and **what it may do**: **Read only** or **Read & write** (preselected
  when asked for).
- **Admin actions**, only if the app asked for them. They are never preselected, and ticking them asks
  for your password. After several wrong passwords lazyit makes you wait before you can try again — the
  same wait that applies to password confirmations in the AI chat, so mistakes in either place count
  together.

Choose **Allow access** or **Deny**. For an app that is **not verified**, lazyit asks you to confirm a
second time: continue only if you started the connection yourself, just now, and you recognize where
it sends you (and its domain, when one is shown). lazyit never forwards you to an app without a click, and it asks every time — approvals
are not remembered.

If the screen says the app **isn't allowed**, or that it asked for an address it didn't register,
lazyit stops there and sends you nowhere. Start the connection again from the app, or ask your
administrator — they control which apps may connect in **Settings → AI**.

### How lazyit recognizes an app

Some apps — Claude Code among them — identify themselves by an **HTTPS address** where they publish a
short description of themselves: their name and the addresses they sign in at. lazyit reads that
description from the internet when you connect and remembers it for a while (up to a day), so the app's
name and sign-in addresses come from its publisher rather than from the app itself. lazyit only reads it
from public internet addresses — never from your internal network — does not follow redirects, and refuses
a description that doesn't match the address it came from.

- **No internet access on your lazyit server?** Claude Code still connects: lazyit ships with a copy of
  Claude Code's description and uses it whenever the real one can't be fetched. Other apps that identify
  themselves this way need lazyit to reach their address; if it can't, the consent screen says the app
  isn't allowed.
- **Apps that register themselves** instead (most other MCP clients) work as before.
- Your administrator's list of allowed apps in **Settings → AI** applies either way.

## What happens next

- The first time an app uses its new connection, lazyit sends you a notification (and an email when
  email is configured) so an unexpected connection never goes unnoticed. It links to
  **AI & connected apps**, where you can [revoke it](/help/ai-assistant-connected-apps).
- Every change the app makes is recorded under your name, noting that it came through an AI app.
