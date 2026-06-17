---
title: Taxonomies
category: configuration
subcategory: taxonomies
order: 2
---

# Taxonomies

**Taxonomies** are the controlled vocabularies that classify your records. Instead of letting anyone
type a free-text category, lazyit keeps a curated list per record kind so the same thing is always
named the same way — which keeps filtering, reporting and search consistent. You manage them all from
**Settings → Taxonomies** (administrators only).

## What you can manage

The Taxonomies screen is a single page with a tab bar. Each tab manages one kind:

- **Asset categories** — how assets are grouped (e.g. laptops, monitors, phones).
- **Application categories** — how applications are grouped.
- **Consumable categories** — how consumables are grouped.
- **Article categories** — how knowledge-base articles are filed.
- **Asset models** — the make/model records that assets reference (e.g. *Dell Latitude 5440*). A
  model carries the shared details, so individual assets only record what's unique to that unit.

Each tab is its own create / edit list. Add a new entry, rename one, or remove one you no longer need.

## How taxonomies relate to records

A category or model is a **reference** that records point at — it is not the record itself. An asset
*belongs to* an asset category and *is a* model; it does not own a private copy of either. That is why
keeping the list curated matters: rename a category once and every record that references it follows.

Because records depend on these entries, lazyit protects them: it follows the same
**soft-delete and audit** rules as the rest of the domain, so removing a taxonomy entry does not
silently break the records that reference it. If an entry is in use, fix or reassign the records first.

## Where to manage related setup

- **Locations** are a sibling registry, reached from the Settings home rather than from a Taxonomies
  tab — they describe *where* assets are, not *what kind* they are.
- **Asset categories vs. models** — categories are broad buckets for grouping and filtering; models
  are specific make/model definitions. Use categories to slice your estate, and models to avoid
  re-typing the same hardware details on every unit.

For how models and categories drive the asset experience, see the Assets section of this manual.
