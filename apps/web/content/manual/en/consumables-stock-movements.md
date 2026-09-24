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
back" without filling in a form. The quick buttons never name a recipient: a `−1` is a plain removal, not
a delivery. To record who or where the units went, use **Remove…** (below).

## The detailed form (be specific)

On a consumable's detail page, the **Add…**, **Remove…** and **Adjust…** buttons open a dialog where
you choose:

- a **quantity** (a whole number, 1 or more),
- and, optionally, a **Reason** (a short line — e.g. *restock*, *issued to Ada*) and **Notes**.

For **Remove**, the dialog warns you inline if the quantity exceeds what is on hand; the count is
still enforced when you submit. **Remove** also has an optional **Deliver to** — see the next
section. For **Adjust**, the quantity field becomes a **new stock count** —
the number you actually counted on the shelf — and lazyit sets the on-hand figure to exactly that.

## Deliveries to a person, an asset or a location

A removal can say **where the units went**. In the **Remove…** dialog, **Deliver to** is *Nobody*
by default (a plain removal, exactly as before); pick **A person**, **An asset** or **A location**
and choose one from the search list. That makes the removal a **delivery**:

- **To a person** — two HDMI adapters handed to Ana.
- **To an asset** — a toner fitted to the 3rd-floor printer, a spare disk left in a server.
- **To a location** — a fire extinguisher left on floor 2. A location is only where the units were
  **left**; lazyit does not keep a separate stock count per place.

Only one recipient per delivery. Only live entries are offered: an offboarded person, a deleted asset
or an archived location cannot receive a new delivery. Split a delivery across two recipients by
recording two removals.

A delivery is still an ordinary **Out**: it takes the units off the shelf and cannot go below zero.
It then shows up where you would look for it:

- on the consumable's **Movements** panel, in the **Delivered to** column (linked to the person,
  asset or location);
- on the recipient's own page, in a **Consumables delivered** section — the person's page, the
  asset's page, or the location's page;
- for an asset, also on its **Activity** timeline as **Consumable delivered**. See
  [Assignments & history](/help/assets-assignments-history).

You can also start a delivery from the recipient's side: the **Consumables delivered** section has a
**Deliver consumable** button (pick the consumable, the quantity and optional notes). It records the
same movement.

If you cannot view people, assets or locations, a delivery's recipient shows as *restricted* — you
see that the units went to someone or somewhere, but not to whom.

## Returnable items and returns

Some supplies come back: a loaner headset, a projector remote, a spare charger. Mark those
consumables **Returnable** on their form (see
[Consumables & categories](/help/consumables-consumables-categories)). The consumable's page then
carries a small **Returnable** marker.

A delivery of a returnable item stays **outstanding** until it is returned:

- The recipient's **Consumables delivered** section shows *N outstanding* on it, and a **Return…**
  button (for people who can record stock movements). **Outstanding only** narrows the list to what
  is still out; a date filter narrows it by when it was delivered.
- **Return…** asks how many came back — everything still out by default. A **partial** return is
  fine; the rest stays outstanding. You cannot return more than is outstanding.
- A return is an **In** movement linked to its delivery: the units go back on the shelf, and the
  consumable's **Movements** panel shows it as *Return of delivery #N*, while the delivery row shows
  how many came back and how many are still out.

Whether a delivery is owed back is fixed **when it is made**. Turning **Returnable** on or off later
changes future deliveries only — past ones keep their meaning. A non-returnable delivery is simply a
record of where the units went; nothing is owed back.

When someone leaves, their outstanding items are listed on the offboarding sheet and the printed
return act. See [User lifecycle](/help/users-permissions-user-lifecycle).

## The ledger is permanent

Movements are **immutable**: once recorded, a movement is never edited or deleted. If you got
something wrong, you fix it by recording another movement — an opposite **In**/**Out**, or an
**Adjust** to the correct count. This is deliberate: the history of a consumable's stock stays
honest and auditable. The same goes for deliveries and returns: a mistaken return is corrected with
another movement, never by editing it.

The **Movements** panel on the detail page lists each movement newest-first, showing its type, the
signed quantity (`+`, `−` or `=`), where a delivery went (or which delivery a return gives back), any
reason, **who** performed it, and when. A movement made by a
person shows that person; one made automatically (for example by a service account) shows as
**System**.
