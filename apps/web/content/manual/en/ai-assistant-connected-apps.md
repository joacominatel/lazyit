---
title: Connected apps & personal tokens
order: 1
category: ai-assistant
subcategory: connected-apps
---

# Connected apps & personal tokens

Every AI app that can act as you appears under **Connected apps** on **AI & connected apps** (user menu
→ **AI & connected apps**, at `/account/ai`). From there you review what is connected and cut off
anything you don't recognize.

## What the list shows

Each row is one connection:

- **Apps** you approved on the [consent screen](/help/ai-assistant-claude-code-mcp#the-consent-screen) —
  with their name (marked **Unverified** when lazyit couldn't confirm the publisher) and the address
  they sign in through.
- **Personal tokens** you created, by the name you gave them.

For each one you see what it may do (**Read**, **Write**, **Admin**), when it was connected, when it was
**last used**, and — for a personal token — when it **expires**.

## Revoking

Click **Revoke** and confirm. The app or token loses access on its **next request**; an app has to be
approved again to reconnect, and a revoked token can't be restored.

Revoke anything you don't recognize, anything you no longer use, and any token that may have been
exposed. When lazyit notifies you that **a new AI app connected to your account** and it wasn't you,
revoke it here right away and tell your administrator.

> Turning off the MCP server in Settings → AI only **pauses** connections — they work again when it is
> turned back on. To cut an app off for good, revoke it.

## Personal tokens

On an instance served over **plain HTTP** (LAN mode), AI apps connect with personal tokens instead of
OAuth sign-in — see [How apps connect](/help/ai-assistant-claude-code-mcp#how-apps-connect-oauth-or-personal-tokens).
There, **Connected apps** has a **Create token** button.

1. Click **Create token**.
2. Give it a **name** you'll recognize later (for example, "Claude Code on my laptop").
3. Choose when it **expires** — 30, 90 (the default), 180 or 365 days. Every token expires; pick the
   shortest period you need.
4. Choose its **access**: **Read only** or **Read & write**. Admin actions are never available to a
   personal token.
5. Click **Create token**, then **copy or download the token right away**. It is shown **only once**:
   lazyit keeps only a fingerprint of it and cannot show it again. If you lose it, revoke it and create
   a new one.

Give the token to your AI app — Claude Code asks for it when you enable the lazyit plugin. Treat it like
a password: it acts as you until it expires or you revoke it.

You can have up to **20** active personal tokens. On an HTTPS instance, personal tokens can't be
created — apps sign in with OAuth instead. Tokens created before an instance moved to HTTPS stop
working there, but stay listed until they expire so you can revoke them.

## Good to know

- A connection never has more access than you: if your role loses a permission, so do your apps.
- Connections are tied to your account, not to your browser session. Signing out of lazyit does
  **not** disconnect your apps. When your password changes (or an administrator resets it), or your
  account is deactivated or offboarded, every connection and personal token stops working and
  disappears from the list. Reconnect your apps (or create new tokens) afterwards. To disconnect one
  app, revoke it here.
- Administrators can see and revoke every user's connected apps in **Settings → AI**.
