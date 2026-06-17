---
title: Notification bell
order: 1
category: notifications-activity
subcategory: notification-bell
---

# Notification bell

The bell in the top bar is lazyit's in-app nudge surface: a small, curated set of "someone should
glance at this" events. It is **not** the audit record — that lives in the activity history and the
ledgers. The bell is allowed to forget; the history is not.

## Who sees the bell

The bell shows for **every signed-in person**, but what each person sees is scoped:

- **Broadcast notifications** — the estate-wide operational nudges (a critical-app grant, an admin
  elevation, low stock, a workflow that needs a human or failed) are visible only to people whose
  role holds the **notification** permission. By default that is **administrators only**.
- **Targeted notifications** — a notification addressed to one specific person lands in **their own**
  bell, even if they are not an administrator and hold no notification permission. Today the only
  targeted notification is the **vault-setup nudge** (see below).

So a non-administrator with nothing addressed to them simply sees a clean bell with no badge; an
administrator sees the broadcast feed plus anything targeted to them.

## What triggers a notification

The set of triggers is fixed and deliberately small — the bell is a curated nudge, not a firehose:

| Notification | Fires when |
| --- | --- |
| **Critical-app access** | A grant opened access to an application flagged as critical. |
| **Admin granted** | A grant or role change raised someone to the Administrator role. |
| **Low stock** | A consumable crossed from above its minimum stock to at or below it. |
| **Manual task** | A workflow run paused and is waiting for a person to act. |
| **Run failed** | A workflow run failed or escalated and stopped. |
| **Vault setup** | (Targeted, one-time) A person who can read secrets but has never set a vault passphrase is nudged at sign-in to set one up. |

Notifications are emitted **after** the originating action completes and are **best-effort**: a
notification that fails to send never blocks or undoes the underlying change. Repeated triggers for
the same event collapse into one notification, so a consumable hovering around its threshold will not
spam the bell.

## Reading and clearing

Open the bell to see the most recent notifications, newest first. Each row carries an icon, a short
title, an optional one-line summary, and a relative time.

- **Click a row** to open what it is about — the application, the consumable, or the workflow task
  inbox — and the row is marked read.
- **Mark all read** clears the unread badge in one click.
- The **red badge** counts unread notifications; it shows `99+` past ninety-nine.

Read state is per person: marking a broadcast read clears it for you only, not for other
administrators.

## What a notification carries

Notification text is short and **redacted by design** — it carries names and identifiers only, never
record bodies, secrets, or sensitive personal data. The vault-setup nudge in particular carries no
key material: it only says a vault passphrase has not been set and links to the Secret Manager.

## Retention

The bell keeps notifications for **90 days**, then prunes the old ones automatically. This is
intentional: the bell is an operational nudge surface, so it is allowed to forget. The durable record
of who did what lives in the [activity history and reports](/help/notifications-activity-activity-reports),
which is never pruned this way.

## Delivery

In the current version the bell **polls** for new notifications, so there is a short delay before a
new event appears. Live push is a planned upgrade behind the same surface; nothing about how you use
the bell changes when it lands.

## Granting the bell to other roles

The broadcast feed is administrator-only by default because it surfaces sensitive operational state
(who was given access to a critical app, who was made an administrator). An administrator can grant
the notification permission to the Member or Viewer role from the role-permission settings if they
want those roles to see the broadcast feed. See [Permissions](/help/permissions) for how to tune what
each role may do.
