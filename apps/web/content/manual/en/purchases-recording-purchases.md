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
edit purchases** *and* the permission to create and edit assets. Receiving a consumable line into stock
changes stock, so it needs **Record & edit purchases** *and* the permission to edit consumables. Applying a
license line changes its application, so it needs **Record & edit purchases** *and* the permission to edit
applications. [Reading a document with AI](#reading-a-document-with-ai) needs **Record & edit purchases**
*and* the permission to use the AI assistant.

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

There are four kinds of line:

- **Asset** — hardware you will register as assets. You can note the **brand** and **model as written**
  on the document, map it to an **asset model** if you already have one (not required — you can map it
  later), and record the **warranty** in months.
- **Consumable** — toner, cables, batteries: units that go into a [consumable's](/help/consumables-consumables-categories)
  stock rather than becoming assets. You can pick the **consumable** they go into now, or leave it for when
  they arrive.
- **License** — seats of software: a subscription renewal, more seats of an application. Its quantity is
  the **seats** bought, and you can pick the [application](/help/applications-applications) they are for now
  or when you apply them. See [Applying a license](#applying-a-license).
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
the assets linked to each line — and, on a consumable line, from the stock received on it — so an ordered purchase also reads as **Partially received** or
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
- **Scan** next to the serial numbers reads them with the camera — see
  [Scanning serial numbers](#scanning-serial-numbers).

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

### Scanning serial numbers

At the warehouse door, with a phone, **Scan** next to the serial numbers opens the camera right in the
form. Hold the serial-number barcode of each box steady inside the wide box — Code 128, Code 39, Code 93,
EAN-13/EAN-8, UPC-A/UPC-E and ITF barcodes are read, and QR and Data Matrix codes too — and each new code
is added on its own line with a green check (and a short vibration on phones that have one). A code
already in the list is not added twice; you are told instead. Choose **Done** to close the camera; the list
stays editable, so you can fix or remove a line by hand.

If nothing is read after a few seconds, a tip appears: hold the barcode flat and still, at the distance
where it looks sharp — a laptop webcam doesn't focus up close, so not right against the lens — and add
light. A box with several barcodes (serial, model, EAN) reads whichever is in the box: keep only the
serial in it. And a code that won't read can always be typed.

The camera needs your browser's permission and a secure (HTTPS) connection. Without a camera, or if you
deny access, the form says so and you type or paste the serials as before.

## Receiving into stock

A **consumable** line is received into its consumable's stock, not as assets. Choose **Receive** on the
line (or **Receive into stock** in its menu, or **Receive** on *Pending units*):

- **Quantity received** starts at the units still pending. Type what actually arrived — receiving more
  than pending is allowed, with the same warning and **Raise the line** offer as for assets.
- If the line has **no consumable** yet, the form asks for one; it is saved on the line, so the next
  delivery already has it.
- **Note** is optional. It is stored on the consumable's stock movement, and **anyone who can see that
  consumable's movements can read it — Viewers included** — so don't put invoice or supplier details there.

Receiving posts one **In** movement on the consumable (its stock goes up, as with any [stock
movement](/help/consumables-stock-movements)) and the line counts the units as received. The movement's
reason names the purchase's reference — *Received from purchase OC-4512*, or *Received from a purchase* when
the purchase has no reference — so **anyone who can see that consumable's movements sees the reference,
Viewers included**. Nothing else about the purchase (supplier, prices, documents) is shown there. A stock
receipt cannot be undone from the purchase: if you received too much, correct the stock with an ordinary
movement on the consumable — the line keeps counting what was received. For the same reason, a consumable
line that has received stock can no longer change its type or be removed.

## Applying a license

A **license** line never changes its application's seats on its own. When the seats are really yours,
choose **Apply license** on the line (or on *Pending units*). The form reads the application first and
shows what applying would do:

- the application's **seats bought** now — and after —, the seats **in use** and its **renewal date**;
- **Seats to add** starts at the line's seats not applied yet. Change it if fewer arrived, or leave it blank
  to set only the renewal;
- **New renewal date** is optional and never filled in for you: the purchase doesn't say how long the
  license lasts, so type it when this purchase renews it.

Only what you confirm is applied, exactly as if you had edited the application. The line counts the seats
as **applied** ("10 of 25 seats applied"), just like units received.

- Applying **more seats than the line bought** is allowed, with a warning; the line then shows more seats
  than bought.
- An application that **doesn't count seats yet** (no seats bought set — unlimited) starts counting from the
  seats you add; the form says so first.
- A line **without an application** asks for one first, and saves it on the line.

Applied seats are not taken back from the purchase: if you applied too many, correct the seats on the
application. For the same reason, a license line with applied seats can no longer change its type or be
removed.

## Linking assets you already have

Assets bought before you started recording purchases — or registered by hand — can be linked to their
purchase line afterwards. There are three ways in:

- On the purchase, **Link existing assets** in a line's menu: search and tick the assets. The list starts
  filtered to the line's model and to assets **not linked to a purchase**; remove a chip to widen it (an
  asset already on another purchase can still be moved here, see below).
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

### Creating a purchase from assets

When the purchase was never recorded at all, select the assets on the **Assets** list and choose **Create
purchase** in the selection bar. A small form asks for the **supplier**, the **reference** and the
**currency** — all optional, all suggested as you type. lazyit then creates **one purchase** with **one
line per model** (assets without a model are grouped by name), each line's quantity being its assets, and
links every asset to its line.

- **Only the link changes.** No cost, date or other field of the assets is touched. A line's unit price is
  filled only when **every** asset of the line has the same cost in the purchase's currency; otherwise it is
  left blank — never an average.
- Leave **Currency** blank to use the label the assets' costs already share.
- Assets that are archived, or already on another purchase, are **left out** and listed with the reason;
  the purchase is created with the others. (Move an asset from its purchase with **Link existing assets**.)
  If none of the selected assets can be linked, nothing is created.

### Unlinking

**Unlink from purchase** on the asset's **Purchase** panel removes the link. The asset **keeps its purchase
values** — unlinking never clears anything — and both the asset's history and the purchase's activity log
record it.

You can also unlink from the purchase's side: on a line that has received units, **Show assets** under
its "x of y received" lists the assets linked to it, each with a link to its page and **Unlink**. The list
is only loaded when you open it, and shows the first 50 assets of a line.

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
existing assets** and **Cancel remaining units**. On a consumable line, **Receive** opens
[Receive into stock](#receiving-into-stock), and there is nothing to link. A license line offers
[Apply license](#applying-a-license) instead. A purchase whose **expected delivery** date has passed is
marked **Overdue**.

## Documents

A purchase keeps its **documents** — the quote, the order, the invoices, a photo of the delivery note — in
the **Documents** section of its page. Upload with the button or by dragging files onto the section; the
same file types and size limit as [asset documents](/help/assets-asset-basics#documents) apply. Anyone who
can view purchases can download them; uploading and deleting need **Record & edit purchases**. Adding or
removing a document is recorded in the activity log.

Each document can carry an optional **type** — *Quote*, *Invoice*, *Delivery note*, whatever your team
writes. Types already used are suggested as you type, and none is required. Fill **Type** before
uploading to set it on the files of that upload, or use the pencil on a document to set, change or clear
it later (empty the field to clear it). The type shows next to the file name, here and on every linked
asset; changing it is recorded in the activity log.

The documents are **shared, not copied**: every asset linked to the purchase lists the same files in its
**Purchase** panel.

> **Backups.** Uploaded files are stored on the server's file volume, which is **not yet covered by the
> database backup** — the Documents section says so too. Until backup support ships, keep your own copy of
> any invoice, order or delivery note you need to keep.

## Reading a document with AI

lazyit can read an invoice, a quote or a delivery note and **fill the purchase for you to review**. It is
**off by default**: an administrator turns on **Document extraction** in
[Settings → AI](/help/ai-assistant-setup#document-extraction), and it needs the AI assistant on with a
provider that reads documents (Anthropic, OpenAI or Google Gemini).

**What is sent.** When someone reads a document, the **whole file** — with the supplier, the prices and the
tax IDs it shows — goes to the AI provider set up in Settings → AI, under your contract with it. No other
lazyit data goes with it, not even the file name. Each read counts against that person's daily AI
budget and is recorded in the purchase's activity log (who, which provider and model — never the values
read).

There are three ways in:

- On a purchase, **Read this document** on a PDF or image in its **Documents** (up to 10 MB — a little less
  for images with some providers — and 20 pages).
- On **New purchase**, **New purchase from a document**: pick the file, and lazyit creates a **draft**
  purchase named after the file, attaches the file and reads it. Saving the review fills in the purchase
  and **marks it as ordered** (ticked for you — untick it to keep it a draft). If you stop before saving, the
  draft keeps the document and you can fill it in by hand.
- On a purchase, **Ask AI to fill** on a document opens the [AI assistant](/help/ai-assistant-using-the-chat#filling-a-purchase-from-a-document)
  — in a new chat if the open one has messages — with a message asking it to read that document and fill in
  the purchase. Send it, answer the few
  questions it asks, and approve the card it proposes — there is no review screen, and nothing is saved
  until you approve. It is shown only where *Read this document* is, and when you can use the assistant.

Reading takes up to two minutes. If it fails, nothing was filled and the document stays attached — the
screen says why (the provider was busy, the file has too many pages, the daily budget is spent…).

### Reviewing the draft

The review shows the **document beside the draft**: an image right there, a PDF as a card whose **Open in a
new tab** opens it in your browser's own viewer — put that tab beside the review. **Nothing is saved until
you select Save**, and then only what is ticked:

- **Hover or focus a value** to see what was read and on which page — `Read "1.412.500,00" · page 1`. That is
  how a misplaced thousands separator is spotted at a glance.
- **Blanks over guesses.** A value the document doesn't state plainly stays **blank**, marked **Not read** —
  never filled with a guess. A new line's quantity that was not read must be typed before that line can be
  added; an unknown price simply stays unknown.
- **Check** marks what needs your eyes, and the counter at the top jumps from one to the next:
  - an amount that reads two ways (`1.150` — one thousand one hundred fifty, or one point fifteen?) is left
    blank; so is one with more than two decimals;
  - a date that could be day/month or month/day, with nothing in the document to settle it, is left blank;
  - a currency shown only as a symbol several currencies share (`$`);
  - a line whose quantity × unit price is not the line total the document prints.
- **If saving stops half-way** (a connection drop, a refusal), what was already saved is kept and shown as
  **Saved**, locked; **Save** then writes only the rest.
- **The totals check** compares the lines, as you correct them, with the net (or total) the document
  prints: **Match**, or by how much they **differ** — usually a line without a price.
- **The supplier** is matched to one you have, by tax ID (most reliable) or by name (check it). You can use
  the match, **create** the supplier as written on the document (with its tax ID), or type another one.
- **A line's model** is mapped like an earlier purchase line with the same description, or suggested from
  the brand and model written on the document (check it). You can change it, or leave it for when the
  units arrive.

### Proposed changes on a purchase that has data

Reading a later document — the invoice after the quote — never overwrites the purchase. Each value is
compared with what the purchase has, the same rule as [linking assets](#choosing-which-values-to-copy):

- a value the purchase **doesn't have yet** is ticked for you (**Fill**);
- a value that would **replace** a different one is **never** ticked for you (**Replace**) — tick the ones
  you want;
- a value the purchase already has is left out.

A document line with the **same description** as a line of the purchase proposes changes to that line
(quantity, unit price, warranty); any other line is offered as a **new line**. Changing the currency
changes it for the whole purchase, and the form says so.

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
linked, moved or unlinked units, who received stock on a consumable line, who applied seats from a license
line, who cancelled remaining units (with the reason), who added or removed a document or changed its type,
who read a document with AI (and with which provider — never the values read), and whether the purchase was
created from selected assets. It cannot be edited or deleted.

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
