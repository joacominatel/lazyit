---
title: Purchases & suppliers
category: purchases
subcategory: recording-purchases
order: 1
---

# Purchases & suppliers

**Purchases** keeps the IT side of what your team buys: which supplier it came from, the finance order
number, the invoices, the lines and prices, and how many of the units have arrived. It answers questions
such as "which assets are on invoice X?" or "did the fourth laptop of that order ever arrive?".

lazyit **records** purchases; it does not run purchasing. Your finance system stays the system of
record — there are no approvals, budgets, payments or exchange rates here.

## It is optional

Nothing in lazyit requires a purchase. An asset never needs one, and the purchase fields on an asset
(date, cost, currency, warranty) keep working exactly as before, whether or not you ever use Purchases.
If your team never records a purchase, the area simply stays empty.

You find it in the sidebar under **Inventory → Purchases**, with two tabs: **Purchases** and
**Suppliers**.

## Who can see it

Purchases has its own permissions, separate from the inventory ones:

| Capability | Administrator | Member | Viewer |
| --- | :---: | :---: | :---: |
| **View purchases & suppliers** | Yes | Yes | No |
| **Record & edit purchases** (purchases, lines and suppliers) | Yes | Yes | No |
| **Delete purchases & suppliers** (archive and restore) | Yes | No | No |

**Viewers have no access by default**, because purchases carry prices and suppliers. An administrator
can grant it from the role permissions screen (see [Permissions](/help/permissions)) — but permissions
belong to a **role**, not a person: granting it to Viewer grants it to **every** viewer. A viewer without
it still sees an asset's own cost fields, as before.

## Recording a purchase

Choose **New purchase**. The form is built to be quick: only what identifies the purchase is needed — **a
supplier, a reference, or one line**. Everything else is optional and can be filled in later.

- **Supplier** — type the name. Suppliers you have used before are suggested as you type, and if what
  you typed is just another spelling of an existing supplier (`COMPUMUNDO SA` for `Compumundo`), a hint
  offers the existing one. A name nobody has used yet creates the supplier when you save — the field
  tells you so. If several suppliers share the exact name, you pick which one.
- **Reference** — the finance purchase-order number. It is what the purchase is called everywhere.
  Without one, the purchase reads as *Supplier · date*, or *Purchase · date* when it has no supplier
  either. References are not checked for uniqueness.
- **Order date** and **Status** — *Ordered* (the default) or *Draft*.
- **Currency** — see below.
- **More details** — expected delivery, where it should be delivered, company, invoice numbers (one
  field, as many as you need), invoice date and notes.

### Lines

Each line is one thing you bought. A line needs only a **description** — as written on the quote or
invoice. Its **quantity** defaults to 1 and the **unit price** is optional (blank means unknown; `0`
means free). The unit price is usually without VAT.

There are two kinds of line:

- **Asset** — hardware you will register as assets. You can note the **brand** and **model as written**
  on the document, map it to an **asset model** if you already have one (not required — you can map it
  later), and record the **warranty** in months.
- **Other** — shipping, a service, a freebie. It counts in the total but never waits for delivery.

The keyboard does most of the work: **Enter** in a line adds the next line, and **Ctrl+Enter** (**⌘+Enter**
on a Mac) saves the purchase. The running total is shown under the lines.

After saving, lines are edited, added and removed on the purchase's page. A line can be removed only
while no asset has been received on it.

## Currency is a label

A purchase's **currency** is a free-text label — `ARS`, `USD`, `u$s`, `pesos`, whatever your team
writes. lazyit attaches no meaning to it: it never converts, never fetches exchange rates and never
changes how a number is shown. It states what the amounts are in, nothing more. The field starts with
the label you used last and suggests the ones already in use.

Totals are therefore **grouped by label and never added across labels**: a list or a total shows one
amount per currency. Labels are compared ignoring capitals and spaces, so `usd` and `USD` are the same
group — but `USD` and `u$s` are two. A purchase without a label shows its amounts as **No currency**,
never as a default currency.

Amounts are typed and shown in your language's number format — see
[Entering amounts](/help/assets-asset-basics#entering-amounts).

## Status and delivery

You set the status yourself: **Draft**, **Ordered** or **Cancelled**. What arrived is worked out from
the assets linked to each line, so an ordered purchase also reads as **Partially received** or
**Received** on its own, and each line shows **"3 of 4 received"**, with any pending or cancelled units.

- A line can end up with **more** units than it ordered. That is allowed — it is shown as
  **Over-received**, as a warning to look at, never as an error.
- **Cancel purchase** (in the *Status* menu) is offered only while nothing has been received. A
  cancelled purchase can be marked as ordered again.

The **Purchases** list opens on the purchases still **waiting for units**; switch the filter to see all
of them, or filter by status or supplier, and search by reference, invoice number, supplier or item.

## The activity log

Every purchase keeps an append-only **activity** log: who recorded it, who changed the status, who
added, edited or removed a line — with a price or quantity change shown as *before → after*. It cannot be
edited or deleted.

## Suppliers

The **Suppliers** tab is the directory of who you buy from and pay. A supplier is **not** the
manufacturer of the hardware (that is on the asset model) and **not** the publisher of the software (that
is on the application).

A supplier needs only a **name**. It can also hold a **tax ID**, a **website**, a **sales contact** and a
separate **support / RMA contact** — handy when a warranty claim comes up — and notes. Its page lists the
purchases made from it.

Names and tax IDs are not unique, so lazyit never refuses a duplicate; it suggests instead. Typing a
tax ID that another supplier already has tells you whose it is.

## Archiving

Administrators can **archive** a purchase or a supplier. Archiving hides it from the lists without
erasing it, every asset keeps its link, and it can be restored from the archived view.
