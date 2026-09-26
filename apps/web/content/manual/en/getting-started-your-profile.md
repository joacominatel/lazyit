---
title: Your profile
order: 1
category: getting-started
subcategory: your-profile
---

# Your profile

**Your profile** is your personal, self-service view of what lazyit has assigned to **you** — no
administrator needed. It answers the two questions every team member eventually asks: *"which laptop
(or phone, or monitor) do I have?"* and *"which applications can I get into?"*

## Opening it

Click your **avatar** in the top-right corner and choose **My profile**. It's available to **everyone**,
including read-only (**Viewer**) accounts — you never need elevated permissions to see your own things.

## Your account hub

**Account** (avatar menu → **Account**, at `/account`) is the one place for everything about **your own**
account. Everyone can open it; it shows only what applies to you:

- **You** — your name, email, role and join date, with a shortcut to **My profile**.
- **Your pages** — cards for **My profile**, [Notification emails](/help/notifications-activity-email-preferences),
  **AI & connected apps** (only if you may connect AI apps and your instance has the assistant — see
  [Connected apps](/help/ai-assistant-connected-apps)) and the **Secret Manager** (only if you can read
  secrets — your personal vault password lives there).
- **Password & sessions** — who owns your password (lazyit, or your organization's sign-in provider),
  a **Change password** shortcut on local-account instances, and a sign-out button. On local accounts it
  reads **Sign out on all devices**, because signing out already ends every session you have (see
  [Signing in and out](#signing-in-and-out)), and below it **Your sessions** lists every device you are
  signed in on so you can end just one (see [Your sessions](#your-sessions)).
- **Preferences** — your **language** and **theme** (light, dark or follow your device). See
  [Your language and theme on every device](#your-language-and-theme-on-every-device).

A row of tabs at the top of **Account**, **My profile**, **Notification emails** and **AI & connected
apps** lets you move between them without going back to the menu.

## What you'll see

- **Name** — your first and last name, which you can edit yourself (see
  [Editing your name](#editing-your-name)).
- **Identity** — your email, role and the date you joined. Together with your name, this is exactly how
  you appear to the rest of the team.
- **My assets** — every asset **currently assigned to you** (a live assignment). Each row shows the
  asset's name, its model and location, and its status. Select **View** to open the full asset page.
- **My application access** — the applications you can currently access, each with its access level and,
  where set, an expiry date. If a grant has passed its expiry it's flagged as **Expired**.
- **Past access** — a history of applications you *used* to have access to, showing when each grant
  started and when it was revoked. This section appears only if you have any past access.

## Editing your name

You can fix your own **first and last name** — a typo, a changed surname, the name you actually go by.

1. Open **My profile** and select **Edit name** on the **Name** panel.
2. Change the first name, the last name or both (1 to 100 characters each), then select **Save**.

The new name shows up everywhere at once: in the top-right menu, on asset owners and grants, and in the
**Users** list. If your organization signs in through lazyit's bundled sign-in service, your name there
is updated too. The change is recorded in your user history, like any other name change.

Only the name is editable. Your email, role, employee number, username and manager stay with
administrators.

**When your name comes from the company directory.** If your instance syncs people from Active Directory
or LDAP and you are one of them, the directory owns your name. The **Name** panel shows it read-only,
with a note saying so — an edit here would only be overwritten by the next sync. Ask an administrator to
change it in the directory.

**If saving fails.** If the sign-in service can't be updated at that moment, lazyit changes nothing and
says so — try again in a moment. Service accounts have no profile, so they can't edit a name.

## Your language and theme on every device

Your **language** and **theme** are saved in the browser you set them in **and** on your account.
Change them anywhere — the **Preferences** panel in **Account**, the language row in the avatar menu or
the theme button in the top bar — and both happen at once.

**The browser you are using always wins.** Your saved choice is used only in a browser that has none of
its own: typically the first time you sign in on a new computer or phone, lazyit picks up the language and
theme you chose elsewhere. A browser where you already picked something keeps its own choice, so you can
have a dark theme at home and a light one at work. See [Languages](/help/getting-started-languages).

## Signing in and out

**Signing out.** Click your **avatar** in the top-right corner and choose **Sign out**.

If your instance uses **local accounts** (a lazyit email/username and password):

- **A normal sign-in lasts 12 hours.** After that, lazyit takes you back to the sign-in screen and you
  sign in again. Anything you opened in the meantime (a bookmark, a link) waits behind the sign-in
  screen and opens once you're back in.
- **Keep me signed in.** Tick **Keep me signed in** on the sign-in screen and your session **does not
  expire** — you stay signed in on that browser until you sign out. It is off by default and you choose
  it on every sign-in.
- **Only use it on a personal device you trust.** Because the session never times out, anyone who can
  use that browser is signed in as you until you sign out. Never tick it on a shared, public or borrowed
  computer. The sign-in screen shows this warning when you tick the box.
- **Signing out ends your sessions on every device.** Choosing **Sign out** signs you out everywhere you
  are signed in — this browser, your other computers and your phone — including sessions kept with
  **Keep me signed in**. That is also how you end a session you left open somewhere else.
- A kept session also ends when you change your password (other devices only), when an administrator
  resets your password, or when your account is deactivated or offboarded.

> **On single sign-on (SSO)**, there is no **Keep me signed in** box — how long you stay signed in is
> governed by your identity provider, and signing out ends your session in this browser.

### Your sessions

On local-account instances, **Account → Password & sessions** lists **Your sessions**: every device
signed in to your account, most recently active first. Each one shows:

- the **browser and operating system** (for example *Firefox · Windows*), or *Unknown browser*,
- its **IP address**, when it **signed in** and when it was **last active** (updated every few minutes,
  so it is approximate),
- a **This device** badge on the one you are using, and **Keep me signed in** where you ticked that box.

**End** signs that one device out; lazyit asks you to confirm first. The device is signed out the next
time it does anything, and your other devices stay signed in. Ending **This device** signs you out here
and takes you to the sign-in screen, without touching your other devices. To end all of them at once,
use **Sign out on all devices**.

> **Ending a session is not enough for a lost or stolen device.** It only signs that device out of
> lazyit in the browser. If a device was lost or stolen, **change your password** instead: that signs out
> every device and also disconnects your AI apps and personal tokens (see
> [Connected apps](/help/ai-assistant-connected-apps)).

If you signed in on this device **before your instance was updated** to list sessions, you see one entry
reading *This device — signed in before the update*. It cannot be ended on its own: **Sign out on all
devices** ends it. Other devices signed in before the update are not listed; they end when their sign-in
expires, when you sign out on all devices, or when you change your password.

The list is not shown on single sign-on (SSO), where your identity provider manages your sessions.

## Changing your password

If your instance uses **local accounts** (a lazyit email/username and password, rather than your
organization's single sign-on), your profile also has a **Change your password** panel:

- Enter your **current** password, then your **new** password twice. The new password must meet the
  live checklist (length, upper- and lower-case, a number and a symbol) and must differ from the
  current one.
- On success you **stay signed in on this device**; every *other* session is signed out, and your AI
  apps and personal tokens are disconnected — so a password change is also how you boot a forgotten,
  shared, lost or stolen session.
- If your session was ended while you were changing it (an administrator reset your password, or you
  signed out on all devices from somewhere else), nothing is changed: lazyit says your session was
  revoked and takes you to the sign-in screen.

> **On single sign-on (SSO)**, there is no password panel — your identity provider owns your password,
> and you change it there. This section applies to local-account instances only.

### Your first sign-in (temporary password)

When an administrator creates your local account, they hand you a **temporary** password. The first time
you sign in with it, lazyit **requires you to set your own password before you can do anything else** —
a full-screen prompt that you can't click past until you choose a new one. Once you do, you're taken
straight into the app.

### Forgot your password?

On the sign-in screen, select **Forgot your password?**, enter your email or username, and — if email is
configured for your instance — lazyit sends a **single-use reset link** (it expires shortly). For your
security, the confirmation looks the same whether or not an account matched, so it never reveals who has
an account. Open the link, choose a new password, and sign in. If email isn't configured, ask an
administrator to reset your password for you.

## Read-only by design

Aside from your own name and password (above), your profile is a **view**, not an editor. You can't reassign an
asset or grant yourself access from here — those actions stay with administrators, so the page is always
a safe, honest picture of your current standing. If something looks wrong (an asset you no longer have,
access you still need), contact an administrator — every assignment and grant is timestamped, so the
history is easy to reconcile.

## Related

- The full per-asset page (reached from **View**) shows serial numbers, specs and the asset's own
  history.
- Administrators can see the same asset/access picture for **any** person from the **Users** section.
