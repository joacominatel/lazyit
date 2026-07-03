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
