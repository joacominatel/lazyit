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

Open an application and choose **Grant access** at the top of the page. You pick:

- **User** — the person who gets access. They must be an active user.
- **Access level** *(optional)* — a free-form label such as `admin`, `developer` or `viewer`.
  lazyit stores this verbatim and never interprets it; type whatever the application itself calls
  its roles.
- **Expires** *(optional)* — a date after which the grant is automatically revoked. See "Expiry"
  below.
- **Notes** *(optional)* — context, e.g. "requested for the Q3 migration".

Granting (and revoking) access is an administrator-only action by default.

You can only grant access to an **active** person with a sign-in account. lazyit refuses a grant for
someone who is deactivated (reactivate them first) or a directory-only person.

> Today access is **granted directly** — there is no approval queue. A formal request-and-approve
> workflow is planned; see [Access requests](/help/applications-access-requests).

## One person, several grants

A user can hold **more than one active grant** on the same application — for example `admin` on
the console and `readonly` on the API. lazyit does not collapse or deduplicate these; each grant
is its own record with its own level, expiry and notes. When you grant access to someone who
already has some, the dialog shows what they already hold so you can decide intentionally.

## Editing a grant

From an application's **Access** tab, open a grant's **⋯** menu and choose **Edit expiry and notes**
to change its **expiry** or **notes**. The grant itself — who, which application, and the access level — is intentionally
fixed. To change the **access level**, revoke the grant and create a new one; that keeps the
history honest about what was held and when. The expiry can't be earlier than the date the grant was
made.

## Revoking access

**Revoke** (in the grant's **⋯** menu) ends a grant. This is the offboarding action: the grant stops
being active, but the record stays under **Revoked** in the application's **Access** tab, showing who had access, who granted it, who revoked
it and when. Revoking is **not** a deletion — there is no way to erase a grant, by design.

## Expiry

When a grant passes its expiry date, lazyit **automatically revokes it** — a background sweep runs
periodically and revokes any active grant whose expiry is in the past. The auto-revoke goes through
the normal revoke path, so it ends up under **Revoked** in the application's **Access** tab and triggers any
deprovisioning workflow exactly as a manual revoke would; it is recorded as an automatic (system)
revoke rather than attributed to a person. There is a short window between the moment a grant expires
and the next sweep during which it still counts as active and is flagged **Expired**. **Clear the
expiry** to make a grant permanent — leaving an expiry in place now means the grant will be revoked.

## Where access shows up

- On each **application**, the **Access** tab lists every grant. Above the list, choose what to see:
  **Active** (the default), **Expiring** (active grants that expire within 30 days, plus expired ones
  the sweep has not revoked yet, most urgent first), **Revoked** (most recent first) or **All**. Each
  choice shows its count.
- Each row shows the person and their email, the **access level**, when the grant was made and by
  whom, and its **expiry** — flagged *in N days* when it is close, or **Expired** — or, for a revoked
  grant, when and by whom it was revoked. Notes appear under the person.
- A grantee who has since been deactivated is flagged on their grants, and the page's *Needs
  attention* row counts them, so you can quickly find access that should be cleaned up.
- The application's **Activity** tab lists every grant and revocation with who did it, newest first
  (administrators by default).
- For an access review, **Export CSV** on the **Access** tab downloads the application's active
  grants when **Active** or **Expiring** is selected, and every grant, revoked ones included, when
  **Revoked** or **All** is selected. The search box and the level filter do not narrow the file. A
  person's **Access** tab has the same button for their grants. See
  [Exporting data](/help/notifications-activity-data-export).

## Finding a grant

The **Access** tab is built for applications with thousands of grants. Type in the search box to
find a person **by name or email** (accents and capitals don't matter), and use the level filter to
show only one **access level** — for example everyone with `admin`. The list is sorted by person, so
someone with several grants appears on consecutive rows, one per grant, each with its own **Edit** and
**Revoke**. It shows 25 rows per page; the count under the list says how many match.

> Seeing the access map — who has access to what — is available to administrators and members.
> Viewers do not see the access ledger by default.
