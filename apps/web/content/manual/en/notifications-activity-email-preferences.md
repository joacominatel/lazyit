---
title: Notification emails
order: 1
category: notifications-activity
subcategory: email-preferences
---

# Notification emails

Every signed-in person can choose which notifications lazyit **emails** them. This is a personal,
per-person setting: it changes only your own inbox, never anyone else's, and it does **not** touch the
in-app [notification bell](/help/notifications-activity-notification-bell) — you still see every
notification there.

## Opening your preferences

Open the **user menu** (your avatar in the top-right corner) and choose **Notification emails**. The
page lives at `/account/notifications` and is available to everyone — no special permission is needed.

## How the toggles work

The page shows one switch per notification type that your instance can email you about:

- **On** — you receive an email when that notification fires.
- **Off** — you stop receiving emails for that type. The notification still appears in your bell.

Each switch **saves the moment you flip it** — there is no separate Save button. If a save fails, the
switch returns to its previous position and an error message explains what happened.

## Which toggles you see

The list is **built for you**, not fixed. A type only appears when your instance can actually email it,
which depends on two things:

- **Email must be configured.** If your administrator has not set up outgoing email (SMTP), there is
  nothing to send and the page tells you there is nothing to configure. See
  [SMTP & email](/help/configuration-smtp-email).
- **The notification must reach you.** Most notifications are administrator-only, so a non-administrator
  sees only the types that are actually sent to them.

Because the list is tailored, two people may see different toggles — that is expected.

## What each type means

The available types mirror the bell's triggers — a critical-app grant, an admin elevation, low stock, a
workflow that needs a person or has failed, a sensitive permission grant, an offline reporting agent, a
new lazyit release, the decision on one of your own access requests, or a proactive heads-up that an
asset warranty or an access grant is about to expire. Each toggle carries a one-line description so you
know exactly what turning it off will silence. For the full trigger list, see the
[notification bell](/help/notifications-activity-notification-bell).

## Good to know

- Turning a type off **never** hides it from your bell or from the activity history — it only stops the
  email copy.
- New notification types added in a future release start **on** (opted in) so you never miss a new
  signal by surprise; turn any of them off here if you prefer.
