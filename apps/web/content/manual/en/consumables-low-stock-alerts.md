---
title: Low-stock alerts
category: consumables
subcategory: low-stock-alerts
order: 3
---

# Low-stock alerts

A consumable can carry a **reorder threshold** — the count at which you want to be reminded to
restock. lazyit uses it to flag low items in the list and to raise a notification when an item
crosses below the line. Set the threshold on the consumable form (see
[Consumables & categories](/help/consumables-consumables-categories)); it is optional, and a
consumable with no threshold is never flagged as low.

## What "low" means

An item is **low stock** when its on-hand count is **at or below** its reorder threshold (and it has
a threshold set). It is **out of stock** at 0. On the list, the stock figure turns **amber** when
low and **red** when out; the filter **Low stock only** narrows the list to just the items at or
under their threshold so you can build a shopping list at a glance.

Setting a threshold does not change any stock — it only decides when an item counts as low.

## The notification

When a movement takes a consumable **from above its threshold to at or below it**, lazyit raises a
**low-stock notification** in the in-app notification bell. The nudge names the item and shows how
many are left versus the minimum, so you know what to reorder.

Two details keep it from becoming noise:

- **Only on the downward crossing.** The alert fires on the movement that *first* drops the item to
  or below its threshold. An item that is already low and keeps bouncing around (take one, put one
  back, while still under the line) does **not** keep re-alerting.
- **At most once a day per item.** If a consumable crosses down again on a later day, you get a fresh
  reminder; repeated crossings on the *same* day collapse into one.

The alert is **best-effort**: it never blocks or undoes the stock movement itself. If a notification
can't be raised for any reason, the movement is still recorded — you simply don't get that one nudge.

## Acting on it

A low-stock alert is a reminder to restock, not an automatic order — lazyit does not reorder for you.
When new stock arrives, record an **In** movement (see [Stock movements](/help/consumables-stock-movements)),
and once the on-hand count rises back above the threshold the item drops out of the low-stock view.
