---
title: Connected apps & personal tokens
order: 1
category: ai-assistant
subcategory: connected-apps
---

# Connected apps & personal tokens

Every AI app that can act as you is listed under **Connected apps** on **AI & connected apps** (user menu
→ **AI & connected apps**, at `/account/ai`). Review it now and then, and cut off anything you don't
recognize.

## What the list shows

Each row is one connection:

- **Apps** you approved on the [consent screen](/help/ai-assistant-claude-code-mcp#the-consent-screen) —
  their name (marked **Unverified** unless lazyit confirmed the publisher), the **domain** lazyit checked
  their details at when the app publishes one (for example **Domain: claude.ai**), and the address they
  sign in through. The name is what the app says about itself; the domain is what lazyit checked.
- **Personal tokens** you created, by the name you gave them.

Each shows what it may do (**Read**, **Write**, **Admin**), when it was connected, when it was **last
used** and — for a token — when it **expires**.

## Revoking

Click **Revoke** and confirm. The app or token loses access on its **next request**. An app has to be
approved again to reconnect; a revoked token can't be restored.

Revoke anything you don't recognize, no longer use, or whose token may have been exposed. When lazyit
notifies you that **a new AI agent connected** to your account and it wasn't you, revoke it here at once,
change your password, and tell your administrator.

## Personal tokens

On an instance without an HTTPS address — for example plain HTTP (LAN mode) — AI apps connect with
personal tokens instead of OAuth sign-in (see
[How apps connect](/help/ai-assistant-claude-code-mcp#how-apps-connect-oauth-or-personal-tokens)). There,
**Connected apps** has a **Create token** button.

1. Click **Create token**.
2. Give it a **name** you'll recognize later ("Claude Code on my laptop").
3. Choose when it **expires** — 30, 90 (the default), 180 or 365 days. Pick the shortest you need.
4. Choose its **access**: **Read only** or **Read & write**. Admin actions are never available to a
   personal token.
5. Click **Create token**, then **copy or download it right away**. It is shown **only once**: lazyit
   keeps only a fingerprint. If you lose it, revoke it and create another.

Give the token to your app — Claude Code asks for it when you enable the lazyit plugin; other clients send
it in an `Authorization: Bearer …` header, never in the address. Treat it like a password: it acts as you
until it expires or you revoke it.

You can have up to **20** active personal tokens. On an HTTPS instance they can't be created — apps sign
in with OAuth. Tokens created before an instance moved to HTTPS stop working there, but stay listed until
they expire so you can revoke them.

## What ends a connection

| Event | Effect on your apps and tokens |
| --- | --- |
| You **revoke** one | That one stops for good. |
| You **sign out** of lazyit | **Nothing** — connections belong to your account, not your browser session. |
| Your **password changes** or is reset | **Every** app and token stops and disappears from the list. Reconnect afterwards. |
| Your account is **deactivated or offboarded** | **Every** app and token stops. |
| Your role **loses a permission** | Your apps lose it too — a connection never has more access than you. |
| An administrator turns **External AI agents (MCP)** off | Every connection is **paused**, and works again when MCP is turned back on. |
| A token reaches its **expiry** | It stops; create a new one. |

## For administrators

There is no page yet to review other people's connections. To cut someone off, deactivate or offboard
the account, or reset their password — each ends all of their connections. To stop every connection on
the instance at once, turn **External AI agents (MCP)** off in **Settings → AI** (it pauses them). The
API already lists and revokes anyone's connections for a signed-in administrator
(`GET` / `DELETE /api/oauth/grants`); a screen for it is not built yet.
