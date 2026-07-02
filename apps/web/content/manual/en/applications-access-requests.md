---
title: Access requests
order: 4
category: applications-access
subcategory: access-requests
---

# Access requests

An **access request** lets a person ask for access to an application instead of waiting for an
administrator to grant it directly. The request moves through a small approval flow: **requested →
approved or denied**. On approval it produces an ordinary [access grant](/help/applications-access-grants) —
the same record you get when an admin grants access by hand — so nothing about how access is tracked
changes.

Anyone can request access, including read-only viewers. Deciding on a request is an administrator
capability (the same people who can grant access).

## How to request access

1. Open the application from **Applications** and go to its detail page.
2. In the **Active access** panel, click **Request access**. (If you already have access, or already
   have a request waiting for a decision, the button is replaced by a short status instead.)
3. Optionally add:
   - an **access level** — the kind of access you need, if the application distinguishes them; and
   - a **justification** — a short note so the approver understands why you need it.
4. Click **Send request**. Administrators are notified, and your request appears in the review queue.

You can only have **one pending request per application** at a time. If you already have one, lazyit
tells you so instead of creating a duplicate.

## What happens next

- Administrators see your request in **Access → Access requests** and get a notification in the bell.
- An approver either **approves** it — which creates your access grant immediately — or **denies** it
  with a reason.
- Approval and denial are final for that request. If a request was denied and you still need access,
  you can raise a new one.

## Reviewing requests (administrators)

Open **Access → Access requests** to see everything waiting for a decision. Each row shows who is
asking, which application, the requested level, any justification, and when it was raised.

- **Approve** grants the access right away — no extra form. The new grant behaves exactly like one you
  create by hand (it runs any access workflows and is recorded in the application's access history).
- **Deny** asks for a **reason**, which is required. The reason is shown to the requester so they know
  why.

Reviewing the queue needs the access-requests read permission; approving or denying needs the same
permission as granting access. See [Roles & permissions](/help/permissions).

## Tracking your requests

Open your **Profile** to see **My access requests** — every request you've raised and its current
status (**Pending**, **Approved** or **Denied**). A denied request shows the reason the approver gave.
This is the place to check the outcome; lazyit doesn't send you a separate notification when a decision
is made.
