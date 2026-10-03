---
title: "Purchases — simulated user interview"
tags: [purchases, research, user-research]
status: draft
created: 2026-10-01
updated: 2026-10-02
---

# Purchase Orders in lazyit — simulated user interview

> [!warning] Pre-decision research — [[0099-purchases-scope-model-and-optionality|ADR-0099]] is authoritative
> A **simulated** user interview written before the CEO's decisions of 2026-10-01. It is input, not a
> specification. Where it differs from [[0099-purchases-scope-model-and-optionality|ADR-0099]] or
> [[purchases/decisions|the decisions note]], those win. Notable differences: no net/gross toggle, no
> lazyit running number in v1, and no manual *Closed* status. Superseded by the decisions after
> acceptance (2026-10-01/02): POs are **not turned on per instance** — there is no switch; Purchases is
> always available and optional at entry (D-B); currency is a **free-text label**, not a code from a list
> (D-C); and a supplier is **not required** on a purchase, and nothing is unique (D-D). The persona's
> "warn me, don't block me" on over-delivery is what ADR-0099 §4 now does. Entity design: [[supplier]] ·
> [[purchase-order]] · [[purchase-order-line]] · [[purchase-order-event]]. Back to
> [[purchases/_MOC|the Purchases vault]].


> Simulated user research. One persona answers in character, with a second voice from finance where
> it changes the answer. This is input for a UX expert, not a specification.

## Persona

**Diego Ferreyra, IT & Systems Lead** at a ~150-employee food distribution company with its head
office in Rosario, Argentina, a warehouse in the Rosario outskirts, and a sales office in Buenos Aires.

- **Team of 6:** Diego, two help desk techs (Nico, Romi), one sysadmin/networking (Pablo), one junior
  who handles onboarding and consumables (Agus), and a part-time developer who mostly maintains
  integrations.
- **lazyit:** self-hosted for about 2 years. Roughly 900 assets: ~170 laptops, ~60 desktops, 140
  monitors, ~110 phones, 25 printers, handhelds and label printers in the warehouse, switches, APs,
  2 hosts, a NAS. They use applications and license seats (M365, Google Workspace for sales, the ERP's
  user licenses, antivirus), consumables (toner, cables, mice, keyboards, headsets, adapters), and the
  knowledge base. The AI assistant was turned on six months ago and mostly gets used for lookups.
- **Buying:** 3 to 8 recurring vendors. Two local IT wholesalers/resellers (one big, one small and
  fast), a Dell/Lenovo corporate channel partner, a mobile carrier for phones and lines, a toner and
  printer-service company, a Microsoft CSP reseller, and occasional Mercado Libre or courier imports.
  Prices come in **ARS and USD**. Hardware is usually quoted in USD and invoiced in ARS at the Banco
  Nación exchange rate of the day before. Toner and services are quoted in ARS.
- **Finance/admin:** 4 people. Purchase orders (*órdenes de compra*) are issued in the company ERP
  (Tango Gestión) by **Laura**, the admin and purchasing analyst. The CFO approves anything above a
  threshold. Accounts payable reconciles invoices against POs and delivery notes (*remitos*). Every
  year the external auditor asks for the fixed-asset register.

**Secondary voice — Laura Benítez, Admin & Purchasing Analyst.** She has a Viewer account in
lazyit that she opens about twice a month to look up serials or "who has the laptop with tag
LZ-0412". She does not want another system she has to keep up to date.

---

## 1. Current workflow

**Q: Walk me through the last laptop purchase, end to end.**
**A:** Sales hired four people. HR emailed me two weeks ahead, which was a good week. I asked the big
wholesaler and the Dell partner for quotes by email. Both sent PDFs in USD, valid for 48 hours,
because prices move in Argentina. I forwarded both to Laura with my pick. Laura created the OC in
Tango, the CFO approved it over WhatsApp because it was above the threshold, and Laura emailed the
OC PDF to the vendor. The vendor delivered 3 laptops with a *remito* and said the fourth would come
the next week. The invoice (Factura A) came by email to the payables inbox, in ARS, for all 4. A week
later the 4th laptop arrived on a second remito. Payables paid at 30 days by e-cheq. On my side, Nico
registered each laptop in lazyit with "Receive stock" when it arrived: model, serials, purchase date,
cost. Then he assigned them.

**Q: Where did each document end up?**
**A:** The quotes are in my email. The OC lives in Tango and in Laura's sent folder. Remitos are
paper: Nico signs them at the warehouse door, a photo goes to our team WhatsApp group, and the paper
goes to Laura in a folder. The invoice is in the payables inbox and in Tango. In lazyit, *sometimes*
someone uploads the invoice PDF to *one* of the laptops. Never to all four. Nobody wants to upload
the same PDF four times.

**Q: Who types the purchase cost into lazyit, and from which document?**
**A:** Whoever registers the asset. Usually from the quote, because the quote is what we have in hand
when the box arrives. So the number is often the USD quote and not the ARS invoice. The field has no
currency, so you just have to know. On older assets it's ARS from 2024, and those numbers are
meaningless now.

**Q: Where do you record the vendor and the PO number today?**
**A:** There's no field for either, so it's inconsistent. Some of us write "OC 4512 — Compumundo" in
Notes. Pablo made a custom field called `proveedor` and another called `oc`, and Romi spells them
`Proveedor` and `nro_oc`. The bulk import from the first day mapped a "Proveedor" column to a custom
field too. So the data exists in about four shapes.

**Q: What goes wrong most often?**
**A:** In order:
1. Finance asks "which assets are on invoice A 0003-00012345?" and I can't answer without an hour
   of searching notes.
2. Partial deliveries. Nobody knows if the remaining 1 of 4 ever arrived, because the remito sits in
   a paper folder and lazyit only knows about what we registered.
3. Warranty claims. Dell wants proof of purchase, and the invoice is in somebody's inbox.
4. Cost in the wrong currency, or missing, which makes depreciation and book value nonsense.
5. Toner: we order 20 cartridges and record the stock "In" movement, but there's no trace of which
   order or what it cost.

**Q: Who is the system of record for purchase orders at your company?**
**A:** Tango, and that won't change. Laura issues the OC number and the CFO approves in Tango or over
WhatsApp. If lazyit wanted to be *the* PO system, finance would say no on day one. What I want is the
**IT side of the purchase**: what we bought, from whom, the documents, and which assets came out of
it, tied to the finance PO number.

**Laura (finance):** Please don't make me type the OC twice. If IT records it in lazyit with my OC
number and attaches my PDF, great. If lazyit expects me to approve there, I won't.

**Q: How long does registering a typical delivery take today?**
**A:** About 10 minutes for 4 laptops with "Receive stock", if the serials are readable. With 20
monitors, the slow part is typing serials off the boxes, so it's 30 to 40 minutes. Toner takes a
minute because it's just +20 on stock.

**Q: How many purchases a month are we talking about?**
**A:** About 6 to 12 purchase events a month that involve IT. Two or three are hardware with
serials, three or four are consumables, one or two are license or subscription renewals, and some
months there's an odd one like a service visit, cabling, or a repair.

---

## 2. Adoption

**Q: Would you adopt a Purchase Orders area?**
**A:** Yes, conditionally. I'd adopt it as a purchase record that IT owns: vendor, the finance PO
number, documents, lines, and links to the assets and consumables that came from it. I would not
adopt it as an approval or procurement workflow. That job belongs to Tango and the CFO's WhatsApp.

**Q: What makes it worth it versus a spreadsheet or the ERP?**
**A:** Three things Tango doesn't give me:
- **From the asset, click to the purchase and its invoice.** Tango doesn't know serials or who has
  the laptop.
- **From the purchase, see which units exist, who has them, and what's still pending delivery.**
- **One invoice PDF shared by 20 assets.** Today I either upload it 20 times or once to a random
  asset.

A spreadsheet can do none of that without discipline that dies in a month.

**Q: What would make you abandon it?**
**A:**
- Making it mandatory to create an asset.
- Approvals or statuses I have to babysit for every order.
- Extraction that fills things in wrong *quietly*. One wrong serial or one price off by 10x and I
  stop trusting the whole thing.
- Forms with 30 fields when I need 6.
- Needing finance to log in for it to work.
- Being unable to fix things later, like linking a PO after the asset already exists.
- Generating assets from a PO being slower than "Receive stock" is today.

**Q: What is the minimum useful version?**
**A:**
1. A **vendor list** with no duplicates.
2. A **purchase record** with: vendor, external PO number (free text, finance's number), order date,
   currency, documents (several PDFs and photos), and free notes.
3. **Lines** with a description, quantity, unit price, and optionally a model or a consumable.
4. **Receiving:** from a line, create N assets (essentially "Receive stock" prefilled) or add stock to
   a consumable.
5. **Linking:** from an asset, "link to purchase", including in bulk from the asset list.
6. On the asset page: "Purchased from X on PO Y, see documents".

That alone answers finance's question and the warranty question. Everything else can come later.

**Q: Would you pay with time, and how much setup would you tolerate?**
**A:** I'd tolerate creating 6 to 8 vendors and maybe back-linking the last 6 months of purchases.
More than an afternoon of setup and it goes on the "someday" list.

**Q: Would your techs use it, or only you?**
**A:** If receiving is easier through the PO than without it, yes. Nico wants receiving to be
faster, not more correct. If the PO path costs Nico extra clicks, he'll go around it and use "New
asset" or "Receive stock" directly, and the link will be missing. So the shortest path to register
gear has to *be* the PO path when a PO exists.

---

## 3. The purchase order itself

**Q: What fields matter on the PO header?**
**A:** Must have:
- vendor
- external PO number (finance's)
- order date
- currency
- status
- documents
- notes
- who created it

Nice to have:
- expected delivery date
- requested by (internal person or department)
- delivery location (head office, warehouse, or the Buenos Aires office)
- company or legal entity (we have two CUITs)
- cost center or department to charge
- invoice number(s)
- the free-text reason ("4 new sales hires")

**Q: What's noise?**
**A:** Payment terms, payment method, bank details, buyer signature, incoterms, shipping method,
"approved by" chains. That's finance's and they have it in Tango. Same with tax breakdown beyond
"prices include/exclude VAT".

**Q: Currencies — what do you need?**
**A:** A currency per purchase, ARS or USD, and maybe EUR once in a while. Every line on a PO is in
the same currency. I *don't* want lazyit fetching exchange rates. Which rate (official, the BNA rate
of the day before, the one on the invoice date) is a finance decision, and lazyit would get it
wrong. What I'd like, optionally, is to type a **"USD equivalent"** or an exchange rate I got from
the invoice, so I can report everything in USD. Management in Argentina thinks about IT spend in
dollars.

**Laura (finance):** The invoice usually states the exchange rate used. If IT records the number
printed on the invoice, fine. Don't calculate one.

**Q: Taxes?**
**A:** We're *Responsable Inscripto*, so VAT is recoverable and the asset's cost for us is the **net
amount without VAT**. Computers are typically 10.5% VAT and other things 21%, plus tax collections
(*percepciones*) that I don't understand and don't want to. What I need: a toggle for whether prices
are net or gross, and the asset cost should be the net unit price. Maybe a total with VAT so it
matches the invoice total when finance looks at it. No tax engine.

**Q: Discounts and shipping?**
**A:** Discounts: I record the final unit price. A per-line discount field is noise. Shipping is
sometimes a separate line ("Flete", ARS 25,000). It's a non-inventory line. Finance capitalizes it
into the asset's cost, but I don't care, and I'd rather lazyit not try to spread it across units. If
it does, it must be explicit and optional.

**Q: PO number format?**
**A:** Finance's number looks like `OC 0001-00004512`. Point of sale plus number, in Tango's format.
It must be free text. If lazyit wants its own running number (like `PO-2026-0031`) so purchases
without a finance OC also get one, fine, but the finance number must be the one shown and
searchable. Small purchases like a mouse from Mercado Libre or a reimbursed adapter have *no* finance
OC at all.

**Q: Statuses and lifecycle?**
**A:** I think in terms of delivery, not money:
- **Draft** — I'm building it, maybe from a quote.
- **Ordered** — finance sent it to the vendor.
- **Partially received** — automatic, when some lines or units arrived.
- **Received** — automatic, when everything arrived.
- **Closed** — I'm done with it, manually or automatically when received and invoiced.
- **Cancelled** — kept for the record.

"Invoiced" would be useful as a flag, not a status: "invoice attached: yes or no". "Paid" is not mine
to track. I would never update it, so it would always be wrong.

**Q: Do you want approvals?**
**A:** No, not in lazyit. At most a field saying "approved by finance on date X" or an attached
approval email. If a company *without* an ERP used lazyit as its PO system, it might want approvals,
but that's a different customer from me.

**Q: Editing after the fact?**
**A:** Must be allowed, always, with history: "unit price changed from 1,150 to 1,180 by Nico".
Things change all the time between the quote and the invoice. What I'd want guarded is anything that
**changes linked assets**, like cost propagation. Tell me "this will update the cost on 4 assets" and
let me confirm.

**Q: Quoted price vs invoiced price?**
**A:** In Argentina they differ often. You get the quote in USD on Monday, and the invoice is in ARS
on Friday at another rate. The invoice is the truth for the asset's cost. Keeping the quoted price
too is a nice-to-have, but I'd skip it in v1. The quote PDF attached is enough.

**Q: One PO, many invoices? One invoice, many POs?**
**A:** Both happen. A PO with two deliveries often has two invoices. And the toner vendor sends one
monthly invoice that covers several small orders. I don't need full matching, but I need to attach
several invoices to a PO and record their numbers. Recording that one invoice covers two POs is
rare enough that I'd just attach the PDF to both.

**Q: Would you ever print or send the PO from lazyit?**
**A:** No. Finance sends it. A company without an ERP might want a printable PO, but for me it's
noise.

---

## 4. Vendors

**Q: What do you track per vendor?**
**A:**
- legal name and short or commercial name ("Compumundo" vs "COMPUMUNDO S.A.")
- **CUIT** (tax ID)
- website
- a sales contact (name, email, phone/WhatsApp)
- a **support/RMA contact**, which is different from sales and is the one I actually lose
- notes, for example "RMA via web form, 15 business days" or "delivers only mornings"

Payment terms and bank details are finance's.

**Q: Duplicates?**
**A:** It'll happen for sure: "Compumundo", "COMPUMUNDO SA", "Compumundo S.A.", "compumundo". The tax
ID is the real key for local vendors. When I type a name, suggest existing ones (like "Company" does
today on assets). And when extraction reads a CUIT from an invoice, match on it. Merging duplicates
later would be very welcome.

**Q: Vendor vs manufacturer vs the "Vendor" on applications — is that confusing?**
**A:** Yes, and you should be careful. In lazyit today, the "Vendor" on an application means the
**publisher** (Microsoft, Atlassian). I buy Microsoft licenses from a **CSP reseller**. Models have a
"Manufacturer" (Dell), but I buy Dell from a **wholesaler**. If a new "Vendors" area appears and the
application's "Vendor" field means something else, my team will be confused within a week. In my
head:
- **Supplier**: who I pay.
- **Manufacturer** or **publisher**: who makes it.

Name them differently or explain it right on the screen.

**Q: Vendor history — what would you look at?**
**A:** On a vendor's page:
- all purchases (most recent first) with totals per year, in each currency separately
- the assets that came from them, and how many are still live or failed early (that's a vendor
  quality signal)
- open purchases, meaning ordered but not fully received

**Q: Would you rate vendors or keep scorecards?**
**A:** No. Maybe a free note. Scorecards are for procurement departments.

**Q: One-off vendors like Mercado Libre sellers or Amazon?**
**A:** I'd want a generic vendor like "Mercado Libre" or "Online / other" so I don't create a vendor
per random seller. Vendor should be required on a purchase, but a generic one is fine.

---

## 5. Line items

**Q: What kinds of lines appear on one of your POs?**
**A:** A real one from last quarter, from the wholesaler:
- 4 × Lenovo ThinkPad E14 (assets, with serials)
- 4 × 24" monitor (assets)
- 4 × USB-C dock (assets for me, because they're expensive and we track them)
- 10 × wireless mouse (consumable)
- 2 × HDMI cable 2 m (consumable)
- 1 × shipping (non-inventory)

Another one, from the CSP: 25 × M365 Business Standard, annual commitment. That's a license
renewal, not an asset or a consumable.

Another, from a technician: one visit for cabling plus materials. That's a service.

So yes, mixed lines are the norm.

**Q: How should each line type behave?**
**A:**
- **Asset lines** produce N assets, when I decide.
- **Consumable lines** add an "In" movement of N to an existing consumable, with the purchase as the
  reason.
- **License lines** ideally update the application's seats purchased and renewal date, but I'd
  accept just a link to the application.
- **Service and non-inventory lines** are just recorded. They count toward the total and that's it.

**Q: What does a line need?**
**A:**
- description, as written on the invoice
- quantity
- unit price
- line type: asset, consumable, license, or other

Optional:
- the model (asset) or consumable or application it maps to
- category
- warranty months
- vendor's part number or SKU

Brand and model as free text only until I map the line to a model. I don't want to create a model
just to save a draft.

**Q: Serial numbers on lines?**
**A:** Serials belong to assets, not to PO lines. But at receiving time I want to paste or scan them
in for the units being created, exactly like "Receive stock" does now. Sometimes the vendor's remito
lists serials, and extraction could pull them from the remito photo. I'd want to review those.

**Q: Quantities and partial deliveries?**
**A:** Per line, show "4 ordered, 3 received, 1 pending". Received means assets created from it (or
linked to it), or stock added. Partial delivery is the main reason I'd look at a PO after creating
it. A list of "purchases with pending units" is the view I'd actually use weekly.

**Q: What if they deliver a different model than ordered?**
**A:** It happens: "E14 Gen 5 out of stock, sending Gen 6 at the same price". I need to receive the
line as a different model than the one written on it, without editing the PO line to lie about what
was ordered. A note would be enough.

**Q: Over-delivery or under-delivery?**
**A:** Under-delivery and then cancelling the rest of a line ("the 4th never came, cancelled") must
be possible. Over-delivery is rare; warn me, don't block me.

**Q: Bundles, like a laptop "kit" with a dock and bag at one price?**
**A:** Happens with Dell sometimes. I'd split it myself into lines or put the whole price on the
laptop. Don't build kits.

---

## 6. Generating assets from a PO

**Q: When would you generate assets?**
**A:** At delivery, when the box is physically in our hands and I can read the serials. Almost never
at order time. Creating assets before they exist would pollute the inventory with "In storage" gear
that isn't there. If someone *wants* placeholder assets at order time, they need a clearly different
status or a "pending delivery" marker, but I'd avoid it.

**Q: How many at a time?**
**A:** Whatever arrived. Pick the line, "receive 3 of 4", paste 3 serials, done. I'd also like
"receive everything that arrived" for the whole PO in one go: lines down the page, each with a
quantity and a serials box.

**Q: What should be prefilled?**
**A:**
- model (from the line)
- purchase date
- purchase cost (the line's net unit price)
- currency
- vendor and PO link
- warranty end (delivery or invoice date plus the line's warranty months)
- location (the PO's delivery location)
- company
- status (my default would be "In storage" for new stock)
- the invoice documents (*shared, not copied*)

Plus the asset tag from the auto-tag scheme, as today.

**Q: Purchase date: the order date, the invoice date or the delivery date?**
**A:** Good question, and I don't know. Finance uses the **invoice date** for the fixed-asset
register. Warranty usually starts at the **invoice or delivery date**. Let it default to the invoice
date when there is one, otherwise the delivery date, and let me override it per receipt.

**Laura (finance):** Invoice date. That's what the auditor matches.

**Q: Serial entry?**
**A:** Paste one per line, the same as "Receive stock". From a phone, **scan the barcode on the
box**. That alone would make Nico love the feature. Duplicate serials get flagged per unit, with
partial success, the way "Receive stock" works today.

**Q: What if the asset was registered before the PO existed?**
**A:** That's 100% of my current inventory and will keep happening. Nico registers on arrival, and I
create the purchase record days later when the invoice shows up. So **linking existing assets to a
PO line** is as important as generating them:
- From the PO line: "link existing assets", with a search filtered by model, unlinked, and recent.
- From the asset list: select 4, then "link to purchase".
- Linking should count toward "received" on the line.

**Q: When you link an existing asset, what happens to its cost and dates?**
**A:** Ask me, with a preview: "These 4 assets have a different purchase cost (USD 1,150 vs ARS
1,380,000 on the PO). Update them from the PO? / Keep the asset values". Don't silently overwrite,
and don't silently skip. Most of the time I'll say "update from PO", because the PO is better data.

**Q: Bulk linking older stuff?**
**A:** Yes. For example: "all 20 monitors of model X bought in March 2025". Filter the asset list,
select all, link to a PO line. Lines that end up with more linked units than ordered should warn me.

**Q: Can an asset be on more than one PO?**
**A:** The asset is bought once. But there's an edge case: an upgrade (RAM, a new disk) bought later
on another PO. I'd record the upgrade as a consumable delivered to that asset, or as a note. So one
"origin purchase" per asset is fine. Maybe "related purchases" later.

**Q: Unlinking?**
**A:** Needed, for when I linked the wrong unit. It should leave a history entry.

---

## 7. Document capture and the AI chat

**Q: What documents would you upload?**
**A:**
- quotes (PDF from email)
- the finance OC (PDF from Tango)
- invoices (PDF, an Argentine *Factura A* with CAE)
- remitos (a phone photo, often crooked, sometimes handwritten serials)
- sometimes a screenshot of a WhatsApp conversation with the vendor

**Q: What do you expect automatic extraction to do?**
**A:** Read the vendor (name and CUIT), the document type (quote, OC, invoice, or remito), the
number, the date, the currency, the lines (description, quantity, unit price), net vs total, VAT,
and on remitos the serials if present. Show me a **prefilled draft side by side with the
document**, where each field highlights where it came from. Then I review and save.

**Q: What's the trust bar for extraction?**
**A:** High for numbers, medium for text. Argentine formats are a trap: `1.234.567,89` means
1,234,567.89, and `10,5%` VAT. Dates are DD/MM/YYYY. If it can't read something, leave it blank and
mark it. Never guess. A price misread by a factor of 1,000 because of separators is my nightmare,
and that's the moment I'd stop using it. I want the totals to self-check: "lines add up to X,
document says Y, mismatch". That catches most errors.

**Q: Would you upload a document to an existing PO and have it update fields?**
**A:** Yes, very often. I create the PO from the quote, then the invoice arrives. I upload the
invoice and it should *propose* changes ("unit price 1,150 USD → 1,412,500 ARS; invoice number
A 0003-00012345; invoice date"), and I accept or reject each one. It must never just overwrite.

**Q: The AI chat flow — "here's this purchase order". What do you expect?**
**A:** I'd drop the PDF in the chat (I don't know if the chat takes files today. I've never seen an
attachment button there). It reads it, then asks me only what it can't infer:
1. "Is this vendor COMPUMUNDO S.A. (CUIT 30-…) the existing 'Compumundo'?" (pick or create)
2. "Prices: net or including VAT?" (only if unclear)
3. "Line 'NB LEN E14 G5 I5 16/512': map to model 'Lenovo ThinkPad E14 Gen 5' or create one?"
4. "'Mouse inalámbrico x10': consumable 'Wireless mouse' (stock 3)?"
5. "Is this the finance OC number, or the vendor's quote number?"
6. "Delivery location?" (offer the PO default)
7. "Did anything arrive already? Want to receive units now?" (and ask for serials only if yes)

It should batch those into one form, which the chat's "assistant asks" form already does, instead
of asking 7 messages in a row.

**Q: What should the AI never do without confirmation?**
**A:**
- Create a vendor.
- Create a model or category.
- Create assets.
- Change cost or dates on existing assets.
- Mark lines as received or cancelled.
- Link assets to a PO.
- Attach a document to the wrong PO.
- Merge vendors.

The approval card should show the money in big letters with the currency. Auto-approve in the chat
should *never* cover anything that changes money or creates assets. Creating a draft PO without
asking is the only thing I'd accept.

**Q: What else would you ask the AI?**
**A:**
- "What's pending delivery from Compumundo?"
- "Which assets came on invoice A 0003-12345?"
- "How much did we spend on laptops in 2025, in USD?"
- "When does the warranty run out for the laptops on PO 4512?"
- "Draft an RMA email to the vendor for LZ-0412 with the invoice attached."

That last one would be nice. Lookups are where the chat earns its keep for me today.

**Q: Privacy — does sending invoices to an AI provider bother you?**
**A:** Invoices have our CUIT, prices, and sometimes an employee's name in "deliver to". Prices with
vendors are somewhat sensitive. I'd want extraction to work with the self-hosted model option, and a
clear statement of what's sent. The CFO will ask.

**Laura (finance):** If it goes to a US AI company, I need to ask the CFO first. Prices are
confidential to us versus other vendors.

**Q: Would you use extraction without the chat, just as an "upload and prefill" button?**
**A:** Honestly, more than the chat. The button on the "New purchase" page with "upload invoice →
review prefilled draft" is the flow I'd use every time. The chat is for when I'm lazy or on my phone.

---

## 8. Optional vs mandatory, and existing data

**Q: Should POs be optional per user or per instance?**
**A:** **Per instance.** Per user would be a mess: half the team links to POs and half doesn't, and
the reports lie. But even with POs turned on, the free purchase fields on the asset must stay
editable, because of the Mercado Libre mouse, the gift, and the 2-year backlog. "Turned on" should
mean "the Purchases area exists and asset forms offer linking", not "assets require a PO".

**Q: How should the asset's free fields and the PO coexist?**
**A:** When an asset is linked to a PO line, show the purchase section as "From PO 4512 · Compumundo"
with the values from the line, and let me **override** per asset (this unit had a discount, or it was
a replacement with a different date). Show it clearly when an asset differs from its PO. When an
asset isn't linked, the fields work exactly like today.

**Q: What should happen to 2 years of free-text purchase data when you turn POs on?**
**A:** Nothing, automatically. Leave it. My notes and custom fields stay where they are. Then *help*
me if I want:
- A one-time "suggest purchases from existing data" view: groups of assets with the same model,
  purchase date, and cost, or with the same `oc`/`proveedor` custom field. Each group becomes a
  proposed purchase I accept or ignore.
- The AI could do the grouping too, with my approval.

I'd convert the last 12 months, the stuff still under warranty. Older than that, I don't care.

**Q: Would you want a migration of the `proveedor` custom field into real vendors?**
**A:** Yes, that's the high-value cleanup: list the distinct values of a custom field, map each to a
vendor (create or match), and apply. It's like the import wizard's conflict step. But optional, and
never on upgrade by itself.

**Q: Currency on old assets?**
**A:** This is a real problem today: costs have no currency. When currency arrives with POs, I need
to set the currency on old assets **in bulk by filter** ("everything purchased before 2025-01 is
ARS"). Without that, any spend report mixing old and new is garbage. Unknown currency should be its
own state, not silently "the default".

**Q: If you turned POs off later?**
**A:** Data must stay and stay visible on the assets. Turning a feature off should hide the area,
never erase the link.

---

## 9. Reporting and finance

**Q: What reports would you actually run?**
**A:**
1. **Purchases with pending deliveries.** Weekly.
2. **Assets by purchase / invoice.** Every time finance asks.
3. **Spend per vendor per year**, per currency. At budget time.
4. **Spend per category** (laptops, monitors, phones, consumables, licenses) per year. At budget
   time.
5. **Warranty expiring**, which exists today, but grouped by purchase so I can plan a renewal batch.
6. **Fixed-asset register export** for the auditor once a year: asset tag, serial, model,
   description, purchase date, invoice number, vendor, net cost, currency, current status, location,
   and book value.

**Q: Depreciation — do you trust lazyit's book value?**
**A:** As an IT number, yes, for "is this laptop worth repairing". As an accounting number, no.
Finance uses tax depreciation (3 years for computers) and inflation adjustment in ARS. Don't try to
match accounting. Maybe label it "estimated book value (IT)" so nobody sends it to the auditor
thinking it's official.

**Laura (finance):** Correct. We'd never take depreciation from lazyit. What I'd take is the list of
assets with serial, invoice number, and cost, to cross-check our fixed-asset register.

**Q: Reconciliation — what does finance actually ask you?**
**A:**
- "We paid invoice X for 10 monitors. Do you have 10 monitors?"
- "This invoice shows 4 laptops but the remito says 3. Did the 4th arrive?"
- Once a year: "The register has 172 laptops. How many do you have?"

So a PO page that shows ordered vs received vs linked assets, with the documents, answers the first
two. The third is an inventory report by category with purchase links.

**Q: Exports?**
**A:** CSV for sure, **and it must open correctly in Excel set to Spanish**. Today's CSVs with
commas and dots end up in one column or with broken numbers for Laura. XLSX would be better for
finance. Export the PO list, the lines, and the assets per purchase.

**Q: Audit trail?**
**A:** Who created the PO, who changed prices, who linked or unlinked assets, who received what and
when, and who deleted or cancelled anything. Same as the asset history today. Nothing hard-deleted.
A cancelled PO stays visible.

**Q: Budgets?**
**A:** I'd love "IT budget 2026: USD 120k, spent so far X". But it's a nice-to-have, and with two
currencies it gets complicated fast. Don't build it in v1.

**Q: Totals with mixed currencies?**
**A:** Never add ARS and USD together. Show them as separate subtotals. If you ever convert, it should
use rates I typed in, and say so on screen.

---

## 10. Permissions

**Q: Who should be able to create and edit purchases?**
**A:** My whole team (Members). Agus does consumable orders, Nico receives laptops, and I do the big
ones.

**Q: Who approves?**
**A:** Nobody in lazyit. See above.

**Q: Who should see prices?**
**A:** For me, laptop prices aren't secret within IT. But I'd want to keep them away from a Viewer
account given to, say, the warehouse supervisor, who can see assets. lazyit's roles are fixed
(Admin, Member, Viewer) and permissions are per area, so "can see purchases" as its own permission
would do it. Purchases visible to Admin and Member, hidden from Viewer by default, and I can grant it
to Laura. I'm not sure about hiding the cost on the asset page from Viewers. It's visible today, so
taking it away might surprise people.

**Laura (finance):** I need to see purchases and documents, read-only. I'd like to upload an invoice
PDF to a purchase too, if that doesn't mean being able to edit assets.

**Q: Who can delete or cancel?**
**A:** Cancelling should be a normal action for Members, kept in the record. Deleting should be
Admin only and soft, like everything else in lazyit.

**Q: AI assistant permissions?**
**A:** Same as the person. If Laura is read-only on purchases, the chat can only read for her.

---

## 11. Edge cases

**Q: Returns and RMA?**
**A:**
- **DOA return:** I return a unit and get a credit note. I'd mark the asset "returned to vendor" and
  attach the credit note to the PO. The line should show that 1 received unit was returned. Today I'd
  deactivate the asset and write a note.
- **Warranty RMA:** I send a laptop to repair and it comes back the same unit. That's just "In
  maintenance" plus a note today. I'd like the vendor's RMA contact and the invoice one click away
  from the asset.

**Q: Replacement units under warranty?**
**A:** Dell sometimes replaces the whole unit, so I get a new serial. That's a new asset record (or a
serial change? I honestly don't know what's right). Either way it should inherit the original's
purchase link, cost, and **original warranty end**, not a fresh warranty. And the old unit should
show "replaced by". This is a question for the UX expert; I can see arguments both ways.

**Q: Cancelled lines?**
**A:** "Cancel remaining 1 of 4" with a reason. The line shows 3 received, 1 cancelled, 0 pending, so
the PO can close.

**Q: Price changes after the order?**
**A:** Common in ARS. Edit the line price, keep the history, and ask whether to update the linked
assets.

**Q: Leased equipment?**
**A:** We lease the warehouse handhelds and label printers from a provider with a monthly fee. They
aren't purchases. I'd want them as assets with a "leased" ownership type, the leasing company, a
contract end date, and the contract PDF. **Not** a PO with a unit price. If you force leases into
POs, the spend reports lie. I'd keep leasing out of v1 but don't paint yourself into a corner.

**Q: Gifts, donations, or vendor freebies?**
**A:** The vendor threw in a free mouse, or the CEO donated an old iPad. Record it on the PO as a line
at price 0, or as an asset with no purchase. "Price 0" must be allowed and different from "unknown".

**Q: Employee bought it and was reimbursed?**
**A:** A sales rep buys a charger at the airport and expenses it. No PO, no vendor relationship. I'd
want "Source: reimbursement" on the asset with the receipt photo, and maybe a generic vendor. Making
me create a PO for it would be absurd. The free fields on the asset should cover it.

**Q: Bought for a project, or for another company we manage?**
**A:** We have two legal entities. The PO's company should flow down to the assets' Company field.

**Q: Used or refurbished gear?**
**A:** Rare. Just a note on the line.

**Q: Subscriptions that renew automatically, like M365 monthly?**
**A:** I don't want a PO per month. One purchase per annual commitment at most, linked to the
application. Monthly invoices are finance's problem. If anything, the application's renewal date and
cost per seat are what I want updated.

**Q: A PO created by mistake, or a duplicate?**
**A:** Cancel it with a reason. If assets were generated, unlink them, or tell me clearly that I
can't cancel it until they're unlinked.

---

## 12. Navigation, first look, and mobile

**Q: Where would you expect to find it?**
**A:** A sidebar item, **"Purchases"**, near Assets and Consumables, because it's an operational
thing, not a setting. Vendors either inside Purchases as a tab or under Settings → Taxonomies like
models. I'd lean towards a tab inside Purchases, since vendors have contacts and history and aren't
just a picklist. On the asset page, a "Purchase" card next to cost and depreciation. On a consumable,
"last purchased from X on date". On an application, "license purchases".

**Q: What would you look at first when opening Purchases?**
**A:** Open purchases, meaning ordered and not fully received, with "X units pending" and how long
ago it was ordered. Then recent ones. Totals don't belong on the landing page.

**Q: What do you look at first on a single PO?**
**A:** At the top: vendor, finance OC number, status, and received/pending at a glance. Then the lines
with progress per line. Then documents. Then the linked assets, with tag, serial, owner, and status.

**Q: Global search?**
**A:** Typing `4512`, an invoice number, or a vendor name in the global search should find the
purchase. That's how finance will ask me: by number.

**Q: Mobile — receiving at the door?**
**A:** That's the moment. The courier is at the warehouse, Nico has a phone, and his hands are full.
What he needs:
- Open "pending deliveries", tap the PO.
- Tap a line, then "receive".
- Scan the serial barcodes with the camera, one after another.
- Take a photo of the remito, which gets attached.
- Done.

If that works on a phone, receiving goes from "later at my desk, from the paper" to "right there",
and that's where most of today's errors go away. If it doesn't work on a phone, it's a desktop
feature, which is fine, but then the remito photo ends up in WhatsApp as today.

**Q: Would you use the chat on mobile for this?**
**A:** "Attach photo of remito: these arrived for PO 4512" and it proposes the receipt, then I
approve. Yes, if extraction is good. A plain scan-and-tap screen is more reliable, though.

**Q: Notifications?**
**A:** Maybe a nudge: "PO 4512 has had 1 unit pending for 14 days". Weekly digest at most. Not a bell
notification per event.

**Q: Anything you'd want on the dashboard?**
**A:** A small "pending deliveries: 3 purchases, 7 units" tile in "Needs attention", next to the
warranty one. Nothing else.

---

## Closing

### (a) Prioritized list, from Diego's point of view

**Must-have (v1):**
1. Vendor directory (name, tax ID, sales and support contacts, notes), with name suggestions so I
   don't create duplicates.
2. Purchase record: vendor, external PO number (free text), own running number, order date, currency,
   net/gross toggle, status, delivery location, company, notes.
3. Several documents per purchase (quote, OC, invoices, remitos), **shared by every linked asset**
   and visible from the asset.
4. Lines: description, quantity, unit price, type (asset / consumable / license / other), optional
   model, consumable or application mapping, and warranty months.
5. Receiving from a line: create N assets with serials (reusing "Receive stock"), prefilled from the
   line and PO, with partial success. Or add stock to a consumable.
6. Linking existing assets to a line, from the PO and in bulk from the asset list, with an explicit
   "update the asset's values from the PO?" preview.
7. Ordered / received / pending / cancelled per line. Automatic "partially received" and "received".
8. The free purchase fields on assets keep working. POs are turned on per instance and never required.
9. Currency on purchases, plus bulk currency assignment for old assets. Never sum across currencies.
10. Full history on purchases and links, and soft delete or cancel only.
11. A "Purchases" permission, separate from asset permissions.
12. CSV/XLSX export of purchases, lines, and assets per purchase that opens correctly in a
    Spanish-locale Excel.

**Nice-to-have (v1.x):**
- Upload-and-prefill extraction from a PDF or photo, with side-by-side review, values highlighted at
  their source, and a totals self-check.
- Updating a PO from a later document (an invoice arriving after the quote), proposed field by field.
- AI chat flow with one batched clarifying form and strict approval for anything with money or
  assets.
- Mobile receiving: scan serials with the camera and photograph the remito.
- A "suggest purchases from existing data" backfill, and mapping custom-field values to vendors.
- Spend per vendor and per category per year, per currency. A manually entered USD equivalent or
  exchange rate.
- A pending-deliveries tile on the dashboard, and a weekly nudge.
- Consumable and application pages showing "last purchased from".
- Replacement and RMA handling that carries the original warranty.
- Merging vendors.

**Don't build:**
- Approval workflows and approval chains.
- Payment tracking ("paid", due dates, payment method), and payment terms or bank details.
- Automatic exchange-rate fetching or FX conversion.
- A tax engine (VAT rates, percepciones).
- Spreading shipping or overhead onto asset cost automatically.
- Sending or printing POs to vendors from lazyit.
- Vendor scorecards.
- Budgets (for now).
- Treating leases as POs.
- A PO per monthly subscription invoice.
- Per-user on/off for the feature.
- Creating assets automatically at order time.

### (b) Top 10 moments of friction Diego fears

1. **The PO path is slower than "Receive stock"**, so techs bypass it and links go missing.
2. **Extraction misreads Argentine number formats** (`1.234,56`) and a price comes out 1,000 times
   off, unnoticed.
3. **Linking an existing asset silently overwrites, or silently ignores, its cost and dates.**
4. **ARS and USD get summed together** in a total or report, or an old cost with no currency gets
   assumed to be USD.
5. **Duplicate vendors** ("Compumundo" ×4) because the name field doesn't suggest or match on tax ID.
6. **"Vendor" means two things**: the application's publisher field versus the new supplier.
7. **Received units don't match ordered lines**: a different model delivered, over- or
   under-delivery, a cancelled remainder. The PO never closes, so the "pending" list becomes noise.
8. **Uploading the invoice again for each asset**, because documents stay per asset.
9. **The AI assistant creates vendors, models or assets in one approval card I didn't read
   carefully**, or auto-approve covers it.
10. **Finance can't open it read-only, or the export breaks in Spanish-locale Excel**, so Laura keeps
    asking me by email anyway.

### (c) Open questions for the UX expert

1. When a delivered unit is a different model than the PO line, is it received "against" the line
   (with a note), or does the line get split?
2. Warranty replacement with a new serial: a new asset linked as "replaces X" and inheriting purchase
   and warranty, or a serial change on the same asset? What does the history show?
3. Which date is "purchase date" for an asset created from a PO: order, invoice, or delivery? Is it
   one default with an override per receipt?
4. How should asset values that differ from their linked PO line be shown: an override badge,
   "differs from PO", or nothing?
5. Should linked assets show the PO's values live, or copy them at link time with an explicit "resync
   from PO"?
6. Where do vendors live: a tab in Purchases, a top-level area, or Settings → Taxonomies? How do they
   relate to the application's publisher field and the model's manufacturer field without confusing
   people?
7. What does "received" mean for a consumable line versus an asset line versus a license line, and how
   does a license line touch the application's seats and renewal date (link only, or propose an
   update)?
8. How does a single "receive delivery" screen handle several lines at once, including on a phone with
   a barcode scanner?
9. Should the PO have its own running number when there's no finance OC? Which number is primary in
   lists and search?
10. Currency on existing assets: how does an operator bulk-assign it, and how is "unknown currency"
    shown in totals and reports?
11. How should the backfill ("suggest purchases from existing assets and custom fields") be presented
    so it's clearly optional and reviewable, and never runs on upgrade by itself?
12. For extraction review, what's the right layout for "document next to draft", and how is low
    confidence or a totals mismatch surfaced without nagging?
13. In the AI flow, which steps belong in one batched "assistant asks" form, and which deserve their
    own approval card? Should auto-approve be disabled for every purchase write?
14. Should one uploaded document (one invoice covering two POs) attach to several purchases, or be
    duplicated?
15. How are price-sensitive fields handled for Viewers: hide purchases only, or also hide cost and book
    value on the asset page, which they can see today?
16. What does turning the feature off look like for an instance that already has purchases: hidden
    area but visible links on assets?
17. Leases and reimbursements: an explicit "how acquired" on the asset (purchased, leased, donated,
    reimbursed), or out of scope?
18. When is a PO "done": auto-close when everything is received and an invoice is attached, or manual
    close only?
