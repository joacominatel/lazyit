---
title: Glossary
order: 1
category: reference
subcategory: glossary
---

# Glossary

A concise A–Z of the terms you will meet across lazyit, written for the people who operate it.
Definitions are intentionally short — each links to the page where the topic is covered in full.

## Access automation

The opt-in, per-application set of steps lazyit can run **on your behalf** when access is granted or
revoked — for example, opening a ticket in another system or calling an external API. An application
with no automation behaves normally: granting access simply records an [access
grant](/help/applications-access-access-grants). See [Access automation](/help/access-automation-concepts).

## Access grant

The record that a **user has access to an application**, with the date it was granted and (when it
ends) the date it was revoked. Grants are kept over time rather than overwritten, so you always have
an answer to "who can access what — and who could, last month?". See [Access
grants](/help/applications-access-access-grants).

## Access request

A pending, approval-gated ask for access to an application. A request becomes an **access grant**
once it is approved. See [Access requests](/help/applications-access-access-requests).

## Activity

The estate-wide, read-only history of what happened in the instance — who created, changed, granted
or revoked something, and when. It is append-only: entries are never edited or removed. See
[Activity & reports](/help/notifications-activity-activity-reports).

## Administrator

The role with full control of the instance: manage users, change settings, delete records, and tune
what the other roles may do. An administrator always holds every permission and cannot be reduced.
See [Roles](/help/users-permissions-roles).

## Assignment

The timestamped link between an **asset and the person who has it**, with a start date and (when the
asset is returned) an end date. Because assignments are kept over time, an asset's ownership history
is automatic. An asset can have more than one active owner at once. See [Assignments &
history](/help/assets-assignments-history).

## Asset

A single, individually tracked thing the IT team owns and is accountable for — a laptop, server,
switch, license, and so on. The asset is lazyit's first-class citizen: it persists while people come
and go. Contrast with a **consumable**, which is counted in bulk. See [Asset
basics](/help/assets-asset-basics).

## Asset category

A classification for asset **models** — Laptop, Desktop, Server, Switch, Firewall, and the like.
Categories drive grouping and filtering. See [Models & categories](/help/assets-models-categories).

## Asset model

The generic make/model an asset is an instance of — for example "Dell Latitude 7440" or "Cisco
Catalyst 9300". The model holds the details shared by every unit, so individual assets don't repeat
them. See [Models & categories](/help/assets-models-categories).

## Asset tag

The short, human-readable identifier printed or stuck on a physical asset (for example `LAP-0042`).
lazyit can assign tags automatically following a scheme you configure. See [Asset
tags](/help/assets-asset-tags).

## Asset tag scheme

The instance-wide rule that defines how asset tags are shaped (prefix, number width) and the running
counter behind them. See [Asset tag scheme](/help/configuration-asset-tag-scheme).

## Consumable

A **stock-counted** supply item — cables, adapters, toner, screws — where you care about *how many*
you have, not *which one*. Contrast with an **asset**, which is tracked individually. See
[Consumables](/help/consumables-consumables-categories).

## Folder

The organizing tree of the Knowledge Base. A folder holds articles and sub-folders, and is also the
**access boundary**: who can read or edit a folder controls who can reach the articles inside it. Each
article has exactly one home folder. See [Folders & access](/help/knowledge-base-folders-access).

## Location

Where an asset physically lives — an office, datacenter, rack, warehouse, or "remote / with the
employee". Locations answer the "where is it?" half of the inventory question. See
[Locations](/help/assets-locations).

## Manual task

A **human step** inside an access-automation workflow. When a workflow reaches a manual task it
pauses and waits for a person to complete it from the tasks inbox; once done, the workflow continues.
It is a provisioning queue, not a general ticketing system. See [Manual
tasks](/help/access-automation-manual-tasks).

## Member

The everyday working role. Members can read and create or edit most things — assets, applications,
consumables, the Knowledge Base — but by default cannot delete records or perform administrator-only
actions. See [Roles](/help/users-permissions-roles).

## Notification

An operational alert surfaced in the in-app **bell** — for example access to a critical application,
an administrator elevation, low stock, or a workflow task waiting for you. See [Notification
bell](/help/notifications-activity-notification-bell).

## Password (Secret Manager)

The secret you use to unlock the Secret Manager each day. It is set inside the Secret Manager and
captured only by your browser — the server never receives it. It is **distinct** from your normal
sign-in password. See [Passwords & recovery keys](/help/secret-manager-passwords-recovery-keys).

## Permission

A single capability written as `area:action` — for example `asset:write` (create or edit assets) or
`consumable:read` (view consumables). A role holds a set of permissions; lazyit checks them whenever
you act. The full list of permissions is fixed and ships with the product. See
[Permissions](/help/users-permissions-permissions).

## Recovery key

Your **backup key** for the Secret Manager: a long, one-time code shown in a five-group format. Use
it to reset your Secret Manager password if you forget it. It is shown **exactly once**, at setup —
store it somewhere safe and outside lazyit. See [Passwords & recovery
keys](/help/secret-manager-passwords-recovery-keys).

## Role

One of three fixed roles — **Administrator**, **Member**, **Viewer** — that every user holds exactly
one of. Roles cannot be created or removed; what an administrator can change is the set of
permissions behind Member and Viewer. See [Roles](/help/users-permissions-roles).

## Secret item

A single secret value stored in a vault — a password, key, or token. Its value is encrypted before it
leaves your browser; the server stores only the encrypted form. See [Vaults &
members](/help/secret-manager-vaults-members).

## Service account

A non-human credential for automation — a script or integration that acts on lazyit without a person
signing in. It is a separate kind of principal from a user, with its own token and its own directly
granted permissions; it is never an administrator. See [Service
accounts](/help/users-permissions-service-accounts).

## Stock movement

An entry in a consumable's running ledger recording one change to the count — stock added (`IN`),
taken out (`OUT`), or set to an exact figure (`ADJUSTMENT`). The ledger is append-only and is the
source of truth for the current stock figure. See [Stock movements](/help/consumables-stock-movements).

## Vault

A folder-like container in the Secret Manager that holds secret items and has its own member list. A
vault is a **zero-knowledge** boundary: the server can see its name and members but can never decrypt
what is inside. See [Vaults & members](/help/secret-manager-vaults-members).

## Viewer

The read-only role. Viewers can look at most areas but cannot change anything, and a few sensitive
views (the user directory and the access-grant ledger) are hidden from them by default. See
[Roles](/help/users-permissions-roles).

## Workflow

The configured sequence of steps that runs as part of access automation for one application — a chain
of automated calls and human (manual) tasks wired together with success and failure paths. There is
at most one workflow per application, and it is opt-in. See [Building a
workflow](/help/access-automation-building-a-workflow).
