---
title: Stock movements
category: consumables
subcategory: stock-movements
order: 2
---

# Stock movements

You never type a consumable's stock count directly. Every change to a count is recorded as a
**stock movement**, and the on-hand figure you see is kept in step with those movements. The list of
movements is an **append-only ledger** — the running record of everything that has happened to a
consumable's stock — and it is the source of truth. Read [Consumables & categories](/help/consumables-consumables-categories)
first if you have not created a consumable yet.

## The three kinds of movement

- **In** — adds to the count (a restock, a new delivery).
- **Out** — subtracts from the count (you issued or consumed some).
- **Adjust** — sets the count to an exact number. Use it for a physical recount, when what is on the
  shelf no longer matches what lazyit thinks.

Every movement records a **positive** quantity; the *kind* (In / Out / Adjust) decides what happens
to the count. An **Out** can never take stock below zero — if you try to remove more than is on
hand, lazyit refuses it and nothing is recorded.

## Quick adjust (the common case)

The fast path is the `−1` / `+1` pair on every consumables list row and on the Stock panel of a
consumable's detail page. One click records a quantity-1 **Out** or **In** and the count updates
immediately. The `−1` button is disabled at 0 on hand. This covers the everyday "took one / put one
back" without filling in a form.

## The detailed form (be specific)

On a consumable's detail page, the **Add…**, **Remove…** and **Adjust…** buttons open a dialog where
you choose:

- a **quantity** (a whole number, 1 or more),
- and, optionally, a **Reason** (a short line — e.g. *restock*, *issued to Ada*) and **Notes**.

For **Remove**, the dialog warns you inline if the quantity exceeds what is on hand; the count is
still enforced when you submit. For **Adjust**, the quantity field becomes a **new stock count** —
the number you actually counted on the shelf — and lazyit sets the on-hand figure to exactly that.

## The ledger is permanent

Movements are **immutable**: once recorded, a movement is never edited or deleted. If you got
something wrong, you fix it by recording another movement — an opposite **In**/**Out**, or an
**Adjust** to the correct count. This is deliberate: the history of a consumable's stock stays
honest and auditable.

The **Movements** panel on the detail page lists each movement newest-first, showing its type, the
signed quantity (`+`, `−` or `=`), any reason, **who** performed it, and when. A movement made by a
person shows that person; one made automatically (for example by a service account) shows as
**System**.
