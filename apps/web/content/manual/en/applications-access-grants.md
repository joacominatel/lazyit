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
- **Expires** *(optional)* — a date after which the grant is automatically revoked. See "Expiry"
  below.
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

When a grant passes its expiry date, lazyit **automatically revokes it** — a background sweep runs
periodically and revokes any active grant whose expiry is in the past. The auto-revoke goes through
the normal revoke path, so it ends up in the application's **History** and triggers any
deprovisioning workflow exactly as a manual revoke would; it is recorded as an automatic (system)
revoke rather than attributed to a person. There is a short window between the moment a grant expires
and the next sweep during which it still counts as active and is flagged **Expired**. **Clear the
expiry** to make a grant permanent — leaving an expiry in place now means the grant will be revoked.

## Where access shows up

- On each **application**, the **Active access** panel lists current grants and a **History**
  panel shows revoked ones.
- A grantee who has since been deactivated is flagged on their grants, so you can quickly find
  access that should be cleaned up.

## Finding a grant

The **Active access** panel groups grants by user — when someone holds more than one, all their
grants appear together under their name with a count badge. You can **search by name** using the
filter box above the list to find a specific person's grants quickly. If the list is long, it
**paginates automatically** (25 per page) so it stays readable no matter how many grants an
application accumulates.

Each individual grant remains fully visible inside the group with its own **Edit** and **Revoke**
controls — grouping is display-only and never hides or merges grants.

> Seeing the access map — who has access to what — is available to administrators and members.
> Viewers do not see the access ledger by default.
