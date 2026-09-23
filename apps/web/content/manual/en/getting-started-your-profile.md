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

## What you'll see

- **Identity** — your name, email, role and the date you joined. This is exactly how you appear to the
  rest of the team.
- **My assets** — every asset **currently assigned to you** (a live assignment). Each row shows the
  asset's name, its model and location, and its status. Select **View** to open the full asset page.
- **My application access** — the applications you can currently access, each with its access level and,
  where set, an expiry date. If a grant has passed its expiry it's flagged as **Expired**.
- **Past access** — a history of applications you *used* to have access to, showing when each grant
  started and when it was revoked. This section appears only if you have any past access.

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

## Changing your password

If your instance uses **local accounts** (a lazyit email/username and password, rather than your
organization's single sign-on), your profile also has a **Change your password** panel:

- Enter your **current** password, then your **new** password twice. The new password must meet the
  live checklist (length, upper- and lower-case, a number and a symbol) and must differ from the
  current one.
- On success you **stay signed in on this device**; every *other* session is signed out — so a password
  change is also how you boot a forgotten or shared session.

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

Aside from your own password (above), your profile is a **view**, not an editor. You can't reassign an
asset or grant yourself access from here — those actions stay with administrators, so the page is always
a safe, honest picture of your current standing. If something looks wrong (an asset you no longer have,
access you still need), contact an administrator — every assignment and grant is timestamped, so the
history is easy to reconcile.

## Related

- The full per-asset page (reached from **View**) shows serial numbers, specs and the asset's own
  history.
- Administrators can see the same asset/access picture for **any** person from the **Users** section.
