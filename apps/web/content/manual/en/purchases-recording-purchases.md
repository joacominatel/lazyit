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

You find it in the sidebar under **Inventory → Purchases**, with three tabs: **Purchases**, **Pending
units** and **Suppliers**.

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
it still sees an asset's own cost fields, as before, but not the asset's **Purchase** panel (below).

Receiving units and linking or unlinking assets also create or change assets, so they need **Record &
edit purchases** *and* the permission to create and edit assets.

## Recording a purchase

Choose **New purchase**. The form is built to be quick: only what identifies the purchase is needed — **a
supplier, a reference, or one line**. Everything else is optional and can be filled in later.

- **Supplier** — type the name. Suppliers you have used before are suggested as you type, and if what
  you typed is just another spelling of an existing supplier (`COMPUMUNDO SA` for `Compumundo`), a hint
  offers the existing one. A name nobody has used yet creates the supplier when you save — the field
  tells you so. If several suppliers share the exact name, you pick which one.
- **Reference** — the finance purchase-order number. It is what the purchase is called everywhere, and
  it suggests the references already used as you type.
  Without one, the purchase reads as *Supplier · date*, or *Purchase · date* when it has no supplier
  either. References are not unique: if the supplier already has a purchase with the same reference, a
  hint links to it, and you can still save.
- **Order date** and **Status** — *Ordered* (the default) or *Draft*.
- **Currency** — see below.
- **More details** — expected delivery, where it should be delivered, company, invoice numbers (one
  field, as many as you need — suggested from the ones already used), invoice date and notes.

### Lines

Each line is one thing you bought. A line needs only a **description** — as written on the quote or
invoice; descriptions you have written before are suggested, so the same item is spelled the same way. Its **quantity** defaults to 1 and the **unit price** is optional (blank means unknown; `0`
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
amount per currency. Labels are compared ignoring capitals and surrounding spaces, so `usd` and `USD ` are
the same group — but `USD` and `u$s` are two. A purchase without a label shows its amounts as **No currency**,
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

## Receiving units

When the boxes arrive, open the purchase and choose **Receive** on the line (or **Receive units** in the
line's menu). It is the same [Receive stock](/help/assets-bulk-receiving) form, already filled in from
the purchase, so usually the only thing to type is the **serial numbers**:

- **Serial numbers** come first — paste or type one per line. The **quantity follows the serials**; with
  the box empty it starts at every pending unit, and you can type a number to receive units without a
  serial.
- **From the purchase** shows what every unit gets: the line's model, status *In storage*, the
  purchase's company, the cost per unit **with the purchase's currency label**, the purchase date and the
  warranty end. Choose **Change** to edit any of them for this receive only.
- The **purchase date** is the purchase's **invoice date**, or **today** when it has none yet — never the
  order date. The **warranty end** is that date plus the line's warranty months.
- The units are placed where the purchase is **delivered to**, and the purchase's documents show on each
  of them.

If the line has **no model** yet, the form asks for one (you can create it on the spot). The model you
pick is saved on the line, so the next delivery already has it.

Each unit is created on its own, so a receive can **partly** succeed — the result lists any unit that
could not be created and why, exactly like Receive stock. The new assets are **linked to the line** and
count as received right away.

You can also start from the other side: on **Receive stock** and on **New asset**, an optional **From
purchase** picker lists the lines still waiting for units, and when you choose a model that a purchase is
waiting for, a quiet hint offers to **receive against it**.

### Receiving more than ordered

Receiving (or linking) more units than a line still expects is **allowed**. The form warns you first —
"this line expects 4 and would end up with 5" — and offers **Raise the line to 5**, which changes the
line's quantity (recorded in the activity log). You can also go ahead without it: the line then shows
as **Over-received**.

## Linking assets you already have

Assets bought before you started recording purchases — or registered by hand — can be linked to their
purchase line afterwards. There are three ways in:

- On the purchase, **Link existing assets** in a line's menu: search and tick the assets. The list starts
  filtered to the line's model; remove that chip to see every model.
- On an asset that is not linked, **Link to purchase** in its **Purchase** panel.
- On the **Assets** list, select several rows and choose **Link to purchase** in the selection bar. Then
  pick the purchase and the line — lines of the same model come first.

### Choosing which values to copy

Before anything is linked, lazyit compares each asset with the purchase, **field by field**: purchase
cost (with its currency), purchase date, warranty end, company and model. The asset's own values stay
in charge — a value from the purchase reaches an asset **only where you tick it**:

- An **empty** field that the purchase can fill is **ticked** for you (*Fill*).
- A field that would **replace** a different value is **never** ticked for you (*Replace*). The **Apply
  every purchase value** switch ticks them all at once.
- **Cost and currency move together**: replacing the cost also sets its currency label.
- Fields that are the same, or that the purchase has no value for, have nothing to apply.

The comparison is grouped by field, so linking twenty monitors is five decisions, not a hundred.
**Show each asset** opens the per-asset grid for the rare case where the assets need different choices.
The line under the table restates what will happen — "4 assets linked · 3 values filled · nothing
replaced" — before you confirm.

The purchase date offered is the purchase's invoice date, or its order date when there is no invoice
date. The supplier, the purchase and its documents are always linked; there is nothing to apply for them.

### Assets already on a purchase

An asset can belong to only one purchase line. Assets already on **this** line are simply left out.
Assets on **another** purchase are listed apart and are **never moved silently**: tick **Move here** for
each one that actually belongs to this line.

If some assets cannot be linked — for example one was archived meanwhile — the others still are, and the
result lists each one that was not, with the reason.

### Unlinking

**Unlink from purchase** on the asset's **Purchase** panel removes the link. The asset **keeps its purchase
values** — unlinking never clears anything — and both the asset's history and the purchase's activity log
record it.

## Cancelling remaining units

When the rest of a line will not arrive, choose **Cancel remaining units** in the line's menu. It
cancels every pending unit by default (you can cancel fewer) and takes an optional **reason**, kept in the
activity log. The line then reads, for example, "3 of 4 received · 1 cancelled", stops waiting for units
and leaves *Pending units*; when it was the last pending line, the purchase reads as **Received**.

## Pending units

The **Pending units** tab lists every line still waiting for units, **grouped by purchase, oldest order
first** — the weekly check, and the screen to open at the warehouse door. Draft and cancelled purchases,
*Other* lines and lines whose remainder was cancelled are not there. Filter it by supplier.

Each line shows "x of y received" and what is still pending, with **Receive** and, in its menu, **Link
existing assets** and **Cancel remaining units**. A purchase whose **expected delivery** date has passed is
marked **Overdue**.

## Documents

A purchase keeps its **documents** — the quote, the order, the invoices, a photo of the delivery note — in
the **Documents** section of its page. Upload with the button or by dragging files onto the section; the
same file types and size limit as [asset documents](/help/assets-asset-basics#documents) apply. Anyone who
can view purchases can download them; uploading and deleting need **Record & edit purchases**. Adding or
removing a document is recorded in the activity log.

The documents are **shared, not copied**: every asset linked to the purchase lists the same files in its
**Purchase** panel.

> **Backups.** Uploaded files are stored on the server's file volume, which is **not yet covered by the
> database backup** — the Documents section says so too. Until backup support ships, keep your own copy of
> any invoice, order or delivery note you need to keep.

## The asset's Purchase panel

An asset linked to a purchase shows a **Purchase** panel on its page, right after *Details*: the purchase
(a link to it), the supplier, the line and its "x of y received", the reference, the order and invoice
dates, the invoice numbers, the currency, the price on the purchase, the supplier's **support contact** —
handy for a warranty claim — and the purchase's documents, ready to download.

- **Only people who can view purchases see it.** Without that permission the panel is not shown at all;
  the asset's own cost, currency and dates stay visible in *Details*, as before.
- **Differs from purchase** marks the price when the asset's own purchase cost is different — another
  amount, or another currency label. Only the cost is compared: dates legitimately differ per delivery.
  lazyit never corrects the cost on its own; edit the asset if it should match.
- If the purchase was **archived**, the panel still says where the asset came from, marked as archived,
  without its documents.
- An asset that is not linked shows the panel only to someone who can link it, with **Link to purchase**.

## The activity log

Every purchase keeps an append-only **activity** log: who recorded it, who changed the status, who
added, edited or removed a line — with a price or quantity change shown as *before → after* — who received,
linked, moved or unlinked units, who cancelled remaining units (with the reason), and who added or removed
a document. It cannot be edited or deleted.

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
