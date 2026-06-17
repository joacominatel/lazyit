---
title: Access grants
order: 2
category: applications-access
subcategory: access-grants
---

# Access grants

An **access grant** records that a person has access to an application — the answer to "**who can
reach what?**". Grants are kept as an append-only history: they are never deleted, so granting and
(just as importantly) revoking access is always auditable. This is what makes offboarding reviews
trustworthy.

## Granting access

Open an application and, under **Active access**, choose **Grant access**. You pick:

- **User** — the person who gets access. They must be an active user.
- **Access level** *(optional)* — a free-form label such as `admin`, `developer` or `viewer`.
  lazyit stores this verbatim and never interprets it; type whatever the application itself calls
  its roles.
- **Expires** *(optional)* — an informational date. See "Expiry" below.
- **Notes** *(optional)* — context, e.g. "requested for the Q3 migration".

Granting (and revoking) access is an administrator-only action by default.

> Today access is **granted directly** — there is no approval queue. A formal request-and-approve
> workflow is planned; see [Access requests](/help/applications-access-access-requests).

## One person, several grants

A user can hold **more than one active grant** on the same application — for example `admin` on
the console and `readonly` on the API. lazyit does not collapse or deduplicate these; each grant
is its own record with its own level, expiry and notes. When you grant access to someone who
already has some, the dialog shows what they already hold so you can decide intentionally.

## Editing a grant

From an application's **Active access** list, you can **edit** a grant to change its **expiry** or
**notes**. The grant itself — who, which application, and the access level — is intentionally
fixed. To change the **access level**, revoke the grant and create a new one; that keeps the
history honest about what was held and when.

## Revoking access

**Revoke** ends a grant. This is the offboarding action: the grant stops being active, but the
record stays in the application's **History**, showing who had access, who granted it, who revoked
it and when. Revoking is **not** a deletion — there is no way to erase a grant, by design.

## Expiry

An expiry date is **informational only**. lazyit does **not** automatically revoke a grant when it
passes its expiry — an expired-but-not-revoked grant is still active access. lazyit marks it as
**Expired** so you can spot it and revoke it yourself. Clear the expiry to make a grant permanent.
(Automatic revocation at expiry is a planned enhancement, not current behavior.)

## Where access shows up

- On each **application**, the **Active access** panel lists current grants and a **History**
  panel shows revoked ones.
- A grantee who has since been deactivated is flagged on their grants, so you can quickly find
  access that should be cleaned up.

> Seeing the access map — who has access to what — is available to administrators and members.
> Viewers do not see the access ledger by default.
