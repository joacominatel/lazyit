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
2. At the top of the page, click **Request access**. (If you already have access, or already have a
   request waiting for a decision, the button is replaced by *You have access* or *Access requested*.)
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
- When a decision is made you get a **notification** in your own bell — and an email, unless you have
  turned that type off in [email preferences](/help/notifications-activity-email-preferences) — telling
  you whether it was approved or denied (a denial includes the reason).
- Approval and denial are final for that request. If a request was denied and you still need access,
  you can raise a new one.

## Filing a request for someone else

People who can approve requests can also file one **on someone else's behalf** — the help-desk case,
where a colleague asks you in person and you want the request on record. Only holders of the
**Grant & revoke access** permission see this option.

- On an application's page, click **Request for someone**; or, from **Access → Access requests**, click
  **File a request** and pick the application.
- Pick the person in **On behalf of**. Leave it empty to request access for yourself. The person must
  be **active and have a sign-in account** — directory-only people and offboarded people can't be
  picked, and lazyit refuses the request if they are.
- The one-pending-request rule applies to that person: if they already have a request waiting for this
  application, lazyit tells you instead of creating a duplicate.

The request then follows the normal approval flow. It records **who filed it**: the queue, the
application's **Requests** tab and the person's own profile show **Filed by**, and the CSV export has a
**Filed by** column. The decision notification goes to the person the request is for, not to whoever
filed it.

## Reviewing requests (administrators)

Open **Access → Access requests** to see everything waiting for a decision. Each row shows who is
asking, which application, the requested level, any justification, when it was raised and, for a
request filed on someone's behalf, who filed it.

- **Approve** grants the access right away — no extra form. The new grant behaves exactly like one you
  create by hand (it runs any access workflows and is recorded in the application's access history).
- **Deny** asks for a **reason**, which is required. The reason is shown to the requester so they know
  why.
- If the person has been **deactivated or offboarded** since the request was filed, lazyit refuses to
  approve it and the request stays pending. Deny it with a reason, or reactivate the person first if
  they should get the access.

Reviewing the queue needs the access-requests read permission; approving or denying needs the same
permission as granting access. See [Roles & permissions](/help/permissions).

**Export CSV** above the queue downloads every pending request — see [Exporting data](/help/notifications-activity-data-export).

Each application's page also has a **Requests** tab with that application's requests only: **Pending**
first, then **Approved** and **Denied**, each showing who decided and when (and the reason, for a
denial). Pending ones can be approved or denied right there, and its **Export CSV** downloads the
requests in the selected status.

## Tracking your requests

Open your **Profile** to see **My access requests** — every request you've raised and its current
status (**Pending**, **Approved** or **Denied**). A denied request shows the reason the approver gave,
and a request an approver filed for you says so. An approved request also shows whether your account in
the application has been set up yet — **No automation**, **Setup in progress**, **Set up** or
**Waiting on IT** (see [Account setup status](/help/getting-started-your-profile#account-setup-status)).
lazyit also notifies you the moment a decision is made — in your bell, and by email unless you opt out —
so this list is the full history, not the only way to learn the outcome.
