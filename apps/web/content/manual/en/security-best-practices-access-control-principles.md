---
title: Access-control principles
category: security-best-practices
subcategory: access-control-principles
order: 2
---

# Access-control principles

lazyit's access model is small on purpose: **three fixed roles** and a **configurable set of
permissions** behind each one (see [Permissions](/help/permissions) for the full picture). This page
covers the principles to keep in mind when you decide who gets what.

## Start people read-only, then promote

New users default to **Viewer** — read-only. This is deliberate: a new identity should be able to
look around but not change anything until someone decides otherwise. Promote a person to **Member**
or **Administrator** when their job needs it, not pre-emptively.

The one exception is the **very first user on a fresh install**, who is made an **Administrator** so
the instance is never left without one. Every account created after that starts as a Viewer.

## Least privilege: grant the smallest role that works

Give each person the **least** they need to do their job:

- **Viewer** for people who only need to look — auditors, occasional users, anyone read-only.
- **Member** for the everyday working role — creating and updating assets, applications, consumables
  and the Knowledge Base.
- **Administrator** only for the small number of people who genuinely run the instance.

Administrator is the most powerful role and the one you should hand out most sparingly. Fewer admins
means fewer accounts whose compromise would be serious.

## Administrator is all-or-nothing — and you always keep one

Two rules about Administrator are worth understanding before you tune permissions:

- **Administrator cannot be reduced.** An administrator always holds every permission; you cannot
  edit the Administrator permission set. This is deliberate — there is always a fully capable admin
  to operate the instance.
- **There is always at least one administrator.** lazyit will not let you remove or demote the last
  one. You can't accidentally lock the whole team out of administration.

Because Administrator is all-or-nothing, the safe pattern is *not* "give this person admin for one
task". It's: keep them a Member and **grant the specific Member permission** they need.

## Tune Member and Viewer — not by editing records

What you **can** change is which permissions **Member** and **Viewer** hold, from the
role-permission settings. Some of those permissions — deleting records, granting application access —
are administrator-level by default; when you hand one to Member or Viewer, lazyit flags it and asks
you to confirm, because it's a meaningful delegation. It won't stop you; it just makes sure the choice
is intentional.

> Permissions are about **areas of the product**, not individual records. If a role can read assets,
> it can read all assets. lazyit does not have general per-record access control — the two deliberate
> exceptions are **Knowledge Base folders** and **Secret Manager vaults**, where access is scoped to a
> folder or a vault.

## No escalation: you can't hand out access you don't have

A principle that runs through the whole product: **you cannot grant access you don't hold yourself.**

- You can only add someone to a **Secret Manager vault** you are a member of — you cannot share
  secrets you can't read yourself.
- You cannot use a **Knowledge Base** link or alias to widen who can see an article you yourself
  cannot access.

This means access can only ever flow *down* from people who already hold it — there's no side door to
escalate through sharing.

## Service accounts are fail-closed

If you automate against lazyit with a **service account** (a non-human token), it follows a stricter
rule than people do: it can do **only** what it was explicitly granted, nothing more, and it can never
be an administrator. Give each automation its own service account with the narrowest set of
permissions its job needs, and rotate its token if it may have been exposed. See the Users &
permissions section for managing service accounts.

## A simple rule of thumb

When in doubt, grant the **smaller** role and add a **specific permission** if it turns out to be
needed. It's easy to grant more later; it's harder to notice that someone has had too much access for
months.
