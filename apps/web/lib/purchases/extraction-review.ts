/**
 * The extraction review (ADR-0099 §11, #1477; docs/purchases/ux-proposal.md §3.b) — the draft an AI provider
 * read from a purchase document, as PROPOSED CHANGES to the purchase it is attached to. Pure, so the mapping,
 * the diff and the payloads are tested without React.
 *
 * Rules, in the order they bite:
 *   - **Nothing is saved until the person confirms.** The draft is never stored by the API; this module only
 *     turns it and the person's choices into the purchase's ordinary write requests.
 *   - **Blanks over guesses.** A value the document did not give plainly is `null` in the draft and stays
 *     blank here ("not read") — never a default. A blank is never sent, so a review never clears a field.
 *   - **Fill, never overwrite silently.** Each value is compared with the purchase as it is (the client-side
 *     diff of the Phase 2 decisions): filling an empty field starts checked, replacing a different value
 *     NEVER starts checked, an equal value is left out. A new purchase is all fills, so the same review serves
 *     *New purchase from a document* and *Propose changes* on a purchase that already has data.
 *   - Amounts arrive in minor units (read by lazyit from the printed text, ADR-0100) and are shown in the
 *     viewer's locale; what the person types is parsed back with `parseMoneyInput`, as everywhere.
 */

import type {
  CreatePurchaseOrderLine,
  ExtractionEvidence,
  PurchaseExtractionDraft,
  PurchaseExtractionLine,
  PurchaseExtractionMatchKind,
  PurchaseExtractionTotals,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  UpdatePurchaseOrder,
  UpdatePurchaseOrderLine,
} from "@lazyit/shared";
import { formatMoney, parseMoneyInput } from "@/lib/utils/money";
import { isDocumentHolder } from "./extraction";
import {
  dateInputToIso,
  emptyLineDraft,
  isoToDateInput,
  type LineDraft,
  type LineErrors,
  toCreateLine,
} from "./payload";

/** How a proposed value relates to the purchase. */
export type ProposalAction = "fill" | "replace" | "same" | "unread";

/** The header fields a document can propose (the supplier has its own proposal). */
export const REVIEW_HEADER_FIELDS = [
  "reference",
  "currency",
  "orderDate",
  "invoiceNumbers",
  "invoiceDate",
] as const;
export type ReviewHeaderField = (typeof REVIEW_HEADER_FIELDS)[number];

const DATE_FIELDS: ReadonlySet<string> = new Set(["orderDate", "invoiceDate"]);

/** One proposed value: what the purchase has, what the document says (editable), and whether to apply it. */
export interface FieldProposal<F extends string = string> {
  field: F;
  /** The purchase's value as form text (`""` = empty; dates `"YYYY-MM-DD"`, money in the viewer's locale). */
  current: string;
  /** The value to apply, as form text — what was read, then what the person typed. `""` = nothing to apply. */
  proposed: string;
  /** Whether the document gave this value (`false` = "not read", left blank). */
  read: boolean;
  evidence: ExtractionEvidence | null;
  /** Warning codes the API attached to this value. */
  warnings: string[];
  /** Whether it is applied on save. */
  checked: boolean;
}

/** The supplier as proposed: matched to an existing one, or a name to create. */
export interface SupplierProposal {
  current: { id: string; name: string } | null;
  /** The supplier name and tax ID as read (`""` when not read). */
  readName: string;
  readTaxId: string;
  match: { id: string; name: string; by: PurchaseExtractionMatchKind } | null;
  /** What the supplier field holds — starts at the match's name, else the name read. */
  text: string;
  /** The supplier picked among same-named ones — starts at the match. */
  chosenId: string;
  evidence: ExtractionEvidence | null;
  taxIdEvidence: ExtractionEvidence | null;
  warnings: string[];
  checked: boolean;
}

/** The fields of a line already on the purchase that a document can propose. */
export const REVIEW_LINE_FIELDS = ["quantity", "unitPrice", "warrantyMonths"] as const;
export type ReviewLineField = (typeof REVIEW_LINE_FIELDS)[number];

/** The draft-line fields that carry evidence. */
export type EvidenceField =
  | "description"
  | "manufacturerText"
  | "modelText"
  | "quantity"
  | "unitPrice"
  | "lineTotal"
  | "warrantyMonths";

/** One line of the document. */
export interface ReviewLine {
  /** Its position in the draft (warnings name lines by it: `lines.2.unitPrice`). */
  index: number;
  /**
   * The purchase's line with the same description, when there is one: then the document proposes changes to
   * it field by field (`fields`). `null` → a new line (`draft`), added when `checked`.
   */
  target: PurchaseOrderLine | null;
  /** The new line as the line editor holds it — the read values, blanks where nothing was read. */
  draft: LineDraft;
  /** On a matched line: the proposed field changes. */
  fields: FieldProposal<ReviewLineField>[];
  /** On a new line: whether it is added. */
  checked: boolean;
  /** Whether the document said what kind of line it is (else it starts as an asset line — check it). */
  kindRead: boolean;
  /** The draft fields the document did not give. */
  unread: EvidenceField[];
  evidence: Partial<Record<EvidenceField, ExtractionEvidence>>;
  /** Warning codes per field (`"line"` for the line as a whole). */
  warnings: Partial<Record<EvidenceField | "line", string[]>>;
  /** The asset model suggested for an asset line: matched by line memory, or by name (check it). */
  modelMatch: { id: string; name: string; manufacturer: string; by: PurchaseExtractionMatchKind } | null;
}

export interface ReviewState {
  /** The purchase is still only the holder made by *New purchase from a document*. */
  holder: boolean;
  /** On a holder that is a draft: mark it as ordered when saving (it was a draft only while being read). */
  markOrdered: boolean;
  supplier: SupplierProposal;
  header: FieldProposal<ReviewHeaderField>[];
  lines: ReviewLine[];
}

const text = (value: string | null | undefined): string => value ?? "";

/** Compare as the purchase does: trimmed; a currency label also ignores case (ADR-0099 §5). */
function sameValue(field: string, a: string, b: string): boolean {
  if (field === "currency") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a.trim() === b.trim();
}

/** How `proposed` relates to `current`. */
export function proposalAction(field: string, current: string, proposed: string): ProposalAction {
  if (proposed.trim() === "") return "unread";
  if (current.trim() === "") return "fill";
  return sameValue(field, current, proposed) ? "same" : "replace";
}

/** Filling an empty field starts checked; replacing never does (the link diff's rule, ADR-0099 §2). */
export function startsChecked(action: ProposalAction): boolean {
  return action === "fill";
}

/** Group warning codes by the path they flag. */
export function warningsByPath(warnings: PurchaseExtractionDraft["warnings"]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const warning of warnings) {
    const list = out.get(warning.path) ?? [];
    list.push(warning.code);
    out.set(warning.path, list);
  }
  return out;
}

/** Normalized description, to find the purchase's line a document line refers to. */
function descriptionKey(description: string): string {
  return description.trim().replace(/\s+/g, " ").toLowerCase();
}

function proposal<F extends string>(
  field: F,
  current: string,
  read: { value: string | null; evidence: ExtractionEvidence | null },
  warnings: string[],
): FieldProposal<F> {
  const proposed = read.value ?? "";
  return {
    field,
    current,
    proposed,
    read: read.value !== null,
    evidence: read.evidence,
    warnings,
    checked: startsChecked(proposalAction(field, current, proposed)),
  };
}

/** A read amount (minor units) → the text a money field holds in the viewer's locale; blank when not read. */
function moneyText(minor: number | null, locale: string): string {
  return minor === null ? "" : formatMoney(minor, locale);
}

function lineFrom(
  line: PurchaseExtractionLine,
  index: number,
  target: PurchaseOrderLine | null,
  modelMatch: ReviewLine["modelMatch"],
  warnings: Map<string, string[]>,
  locale: string,
): ReviewLine {
  const kind = line.kind ?? "ASSET";
  const evidence: ReviewLine["evidence"] = {};
  const unread: EvidenceField[] = [];
  const lineWarnings: ReviewLine["warnings"] = {};
  const fields: [EvidenceField, { value: unknown; evidence: ExtractionEvidence | null }][] = [
    ["description", line.description],
    ["manufacturerText", line.manufacturerText],
    ["modelText", line.modelText],
    ["quantity", line.quantity],
    ["unitPrice", line.unitPrice],
    ["lineTotal", line.lineTotal],
    ["warrantyMonths", line.warrantyMonths],
  ];
  for (const [field, read] of fields) {
    if (read.evidence) evidence[field] = read.evidence;
    if (read.value === null) unread.push(field);
    const codes = warnings.get(`lines.${index}.${field}`);
    if (codes) lineWarnings[field] = codes;
  }
  const whole = warnings.get(`lines.${index}`);
  if (whole) lineWarnings.line = whole;

  const draft: LineDraft = {
    ...emptyLineDraft(`review-${index}`),
    kind,
    description: text(line.description.value),
    manufacturerText: text(line.manufacturerText.value),
    modelText: text(line.modelText.value),
    assetModelId: kind === "ASSET" && modelMatch ? modelMatch.id : "",
    // Blanks over guesses: a quantity the document did not give stays blank — never the default 1.
    quantity: line.quantity.value === null ? "" : String(line.quantity.value),
    unitPrice: moneyText(line.unitPrice.value, locale),
    warrantyMonths: line.warrantyMonths.value === null ? "" : String(line.warrantyMonths.value),
  };

  const proposals: FieldProposal<ReviewLineField>[] = target
    ? [
        proposal(
          "quantity",
          String(target.quantity),
          { value: line.quantity.value === null ? null : String(line.quantity.value), evidence: line.quantity.evidence },
          lineWarnings.quantity ?? [],
        ),
        proposal(
          "unitPrice",
          moneyText(target.unitPrice, locale),
          { value: line.unitPrice.value === null ? null : moneyText(line.unitPrice.value, locale), evidence: line.unitPrice.evidence },
          lineWarnings.unitPrice ?? [],
        ),
        proposal(
          "warrantyMonths",
          target.warrantyMonths === null ? "" : String(target.warrantyMonths),
          {
            value: line.warrantyMonths.value === null ? null : String(line.warrantyMonths.value),
            evidence: line.warrantyMonths.evidence,
          },
          lineWarnings.warrantyMonths ?? [],
        ),
      ]
    : [];

  return {
    index,
    target,
    draft,
    fields: proposals,
    // A line nobody could name cannot be added until the person types a description.
    checked: target === null && line.description.value !== null,
    kindRead: line.kind !== null,
    unread,
    evidence,
    warnings: lineWarnings,
    modelMatch,
  };
}

/**
 * The draft against the purchase → the review. `attachmentName` is the document's file name: on a purchase
 * that is still only the holder of *New purchase from a document* (its reference is the file name's
 * stand-in), the reference is treated as empty, so the one read from the document fills it.
 */
export function buildReview(
  draft: PurchaseExtractionDraft,
  purchase: PurchaseOrderDetail,
  attachmentName: string,
  locale: string,
): ReviewState {
  const warnings = warningsByPath(draft.warnings);
  const holder = isDocumentHolder(purchase, attachmentName);
  const header = draft.header;
  const at = (path: string) => warnings.get(`header.${path}`) ?? [];
  const date = (value: string | null) => (value === null ? null : isoToDateInput(value));

  const currentText: Record<ReviewHeaderField, string> = {
    reference: holder ? "" : text(purchase.reference),
    currency: text(purchase.currency),
    orderDate: isoToDateInput(purchase.orderDate),
    invoiceNumbers: text(purchase.invoiceNumbers),
    invoiceDate: isoToDateInput(purchase.invoiceDate),
  };
  const readText: Record<ReviewHeaderField, { value: string | null; evidence: ExtractionEvidence | null }> = {
    reference: header.reference,
    currency: header.currency,
    orderDate: { value: date(header.orderDate.value), evidence: header.orderDate.evidence },
    invoiceNumbers: header.invoiceNumbers,
    invoiceDate: { value: date(header.invoiceDate.value), evidence: header.invoiceDate.evidence },
  };
  const headerProposals = REVIEW_HEADER_FIELDS.map((field) =>
    proposal(field, currentText[field], readText[field], at(field)),
  );

  const match = draft.matches.supplier;
  const readName = text(header.supplierName.value);
  const current = purchase.supplier ? { id: purchase.supplier.id, name: purchase.supplier.name } : null;
  const supplierBase: SupplierProposal = {
    current,
    readName,
    readTaxId: text(header.supplierTaxId.value),
    match,
    text: match?.name ?? readName,
    chosenId: match?.id ?? "",
    evidence: header.supplierName.evidence,
    taxIdEvidence: header.supplierTaxId.evidence,
    warnings: [...at("supplierName"), ...at("supplierTaxId")],
    checked: false,
  };
  const supplier = { ...supplierBase, checked: startsChecked(supplierAction(supplierBase)) };

  // A document line refers to a purchase line with the same description; each purchase line takes one.
  const free = new Map<string, PurchaseOrderLine[]>();
  for (const line of purchase.lines) {
    const key = descriptionKey(line.description);
    free.set(key, [...(free.get(key) ?? []), line]);
  }
  const lines = draft.lines.map((line, index) => {
    const key = line.description.value === null ? null : descriptionKey(line.description.value);
    const candidates = key === null ? undefined : free.get(key);
    const target = candidates?.shift() ?? null;
    return lineFrom(line, index, target, draft.matches.lineModels[index] ?? null, warnings, locale);
  });

  return {
    holder,
    markOrdered: holder && purchase.status === "DRAFT",
    supplier,
    header: headerProposals,
    lines,
  };
}

/** The supplier proposal's action, as the person left it. */
export function supplierAction(supplier: SupplierProposal): ProposalAction {
  const typed = supplier.text.trim();
  if (typed === "") return "unread";
  if (supplier.current === null) return "fill";
  // The purchase's own supplier, by id when one is picked or matched, else by name.
  const same = supplier.chosenId
    ? supplier.chosenId === supplier.current.id
    : supplier.current.name.trim() === typed;
  return same ? "same" : "replace";
}

/**
 * The person typed into a proposed value: it now holds what they typed, and it is applied when it says
 * something new — an edit is the person's intent, so it checks itself; emptying it unchecks it.
 */
export function editProposal<P extends FieldProposal>(item: P, proposed: string): P {
  const action = proposalAction(item.field, item.current, proposed);
  return { ...item, proposed, checked: action === "fill" || action === "replace" };
}

/** The same for the supplier field. */
export function editSupplier(supplier: SupplierProposal, textValue: string, chosenId: string): SupplierProposal {
  const next = { ...supplier, text: textValue, chosenId };
  const action = supplierAction(next);
  return { ...next, checked: action === "fill" || action === "replace" };
}

/** Why a value in the review cannot be saved as it is. */
export type ReviewFieldError = "invalid";

/** What the review sends, in order: the supplier, the header, the new lines, then the changed lines. */
export interface ReviewPayload {
  /** The supplier to resolve (an existing one, or created with the tax ID read), or `null` for no change. */
  supplier: { text: string; chosenId: string; taxId: string | null } | null;
  /** The header changes (`supplierId` is added once the supplier resolves), or `null`. */
  header: UpdatePurchaseOrder | null;
  addLines: { index: number; line: CreatePurchaseOrderLine }[];
  lineUpdates: { index: number; lineId: string; data: UpdatePurchaseOrderLine }[];
}

export type ReviewPayloadResult =
  | { ok: true; payload: ReviewPayload; changes: number }
  | {
      ok: false;
      headerErrors: Partial<Record<ReviewHeaderField, ReviewFieldError>>;
      /** Per line index: the new line's field errors, or a matched line's. */
      lineErrors: Record<number, LineErrors>;
    };

/** The largest int4 the API accepts for a count (ADR-0036). */
const INT4_MAX = 2_147_483_647;
const WARRANTY_MAX = 1200;
const CURRENCY_MAX = 32;

function wholeCount(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : null;
}

/** Whether a proposal is applied: checked, and saying something new. Blanks are never sent. */
function applies(item: FieldProposal): boolean {
  if (!item.checked) return false;
  const action = proposalAction(item.field, item.current, item.proposed);
  return action === "fill" || action === "replace";
}

/**
 * The review → the purchase's ordinary write requests. Only checked values that say something new are
 * sent; a blank is never sent, so nothing is cleared. A new line needs a description and a quantity the
 * person can vouch for: a quantity the document did not give must be typed (blanks over guesses), while an
 * unknown price stays unknown (ADR-0099 §2).
 */
export function buildReviewPayload(state: ReviewState, locale: string): ReviewPayloadResult {
  const headerErrors: Partial<Record<ReviewHeaderField, ReviewFieldError>> = {};
  const lineErrors: Record<number, LineErrors> = {};
  const header: UpdatePurchaseOrder = {};
  let changes = 0;

  for (const item of state.header) {
    if (!applies(item)) continue;
    const value = item.proposed.trim();
    if (DATE_FIELDS.has(item.field)) {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateInputToIso(value) : undefined;
      if (iso === undefined || Number.isNaN(Date.parse(iso))) {
        headerErrors[item.field] = "invalid";
        continue;
      }
      (header as Record<string, unknown>)[item.field] = iso;
    } else {
      const max = item.field === "currency" ? CURRENCY_MAX : item.field === "invoiceNumbers" ? 500 : 200;
      if (value.length > max) {
        headerErrors[item.field] = "invalid";
        continue;
      }
      (header as Record<string, unknown>)[item.field] = value;
    }
    changes++;
  }
  if (state.markOrdered) {
    header.status = "ORDERED";
    changes++;
  }

  const supplierAct = supplierAction(state.supplier);
  const supplier =
    state.supplier.checked && (supplierAct === "fill" || supplierAct === "replace")
      ? {
          text: state.supplier.text.trim(),
          chosenId: state.supplier.chosenId,
          // A new supplier is created with the tax ID read — only when it is the name read, not another one.
          taxId:
            state.supplier.readTaxId && state.supplier.text.trim() === state.supplier.readName.trim()
              ? state.supplier.readTaxId
              : null,
        }
      : null;
  if (supplier) changes++;

  const addLines: ReviewPayload["addLines"] = [];
  const lineUpdates: ReviewPayload["lineUpdates"] = [];
  for (const line of state.lines) {
    if (line.target === null) {
      if (!line.checked) continue;
      const errors: LineErrors = {};
      if (line.draft.quantity.trim() === "") errors.quantity = "invalid";
      const built = toCreateLine(line.draft, locale);
      if (!built.ok || Object.keys(errors).length > 0) {
        lineErrors[line.index] = { ...(built.ok ? {} : built.errors), ...errors };
        continue;
      }
      addLines.push({ index: line.index, line: built.line });
      changes++;
      continue;
    }
    const data: UpdatePurchaseOrderLine = {};
    const errors: LineErrors = {};
    for (const item of line.fields) {
      if (!applies(item)) continue;
      if (item.field === "unitPrice") {
        const price = parseMoneyInput(item.proposed, locale);
        if (!price.ok) errors.unitPrice = price.error;
        else data.unitPrice = price.minor;
      } else if (item.field === "quantity") {
        const n = wholeCount(item.proposed, 1, INT4_MAX);
        if (n === null) errors.quantity = "invalid";
        else data.quantity = n;
      } else {
        const n = wholeCount(item.proposed, 0, WARRANTY_MAX);
        if (n === null) errors.warrantyMonths = "invalid";
        else data.warrantyMonths = n;
      }
    }
    if (Object.keys(errors).length > 0) {
      lineErrors[line.index] = errors;
      continue;
    }
    if (Object.keys(data).length > 0) {
      lineUpdates.push({ index: line.index, lineId: line.target.id, data });
      changes += Object.keys(data).length;
    }
  }

  if (Object.keys(headerErrors).length > 0 || Object.keys(lineErrors).length > 0) {
    return { ok: false, headerErrors, lineErrors };
  }
  return {
    ok: true,
    payload: {
      supplier,
      header: Object.keys(header).length > 0 ? header : null,
      addLines,
      lineUpdates,
    },
    changes,
  };
}

/** The totals self-check: never stored, recomputed as the person fixes the lines. */
export interface TotalsCheck {
  /** Σ quantity × unit price over the lines that have both (minor units), `null` when none has. */
  linesTotal: number | null;
  /** Lines missing a quantity or a price — the total leaves them out (the likely culprit of a mismatch). */
  incomplete: number;
  net: number | null;
  gross: number | null;
  /** `match` when the lines equal the printed net or gross; `unknown` when either side is missing. */
  state: "match" | "mismatch" | "unknown";
  /** Lines − the printed net (else gross), on a mismatch. */
  difference: number | null;
}

/** A line's quantity and price as they stand in the review (a matched line falls back to its own values). */
function effective(line: ReviewLine): { quantity: string; unitPrice: string } {
  if (line.target === null) return { quantity: line.draft.quantity, unitPrice: line.draft.unitPrice };
  const of = (field: ReviewLineField) => {
    const item = line.fields.find((f) => f.field === field);
    return item && item.proposed.trim() !== "" ? item.proposed : (item?.current ?? "");
  };
  return { quantity: of("quantity"), unitPrice: of("unitPrice") };
}

/** Compare the lines of the document, as reviewed, with the net and gross it prints. */
export function totalsCheck(
  lines: readonly ReviewLine[],
  totals: Pick<PurchaseExtractionTotals, "net" | "gross">,
  locale: string,
): TotalsCheck {
  let sum = BigInt(0);
  let priced = 0;
  let incomplete = 0;
  for (const line of lines) {
    const { quantity, unitPrice } = effective(line);
    const q = wholeCount(quantity, 1, INT4_MAX);
    const price = parseMoneyInput(unitPrice, locale);
    if (q === null || !price.ok || price.minor === null) {
      incomplete++;
      continue;
    }
    sum += BigInt(q) * BigInt(price.minor);
    priced++;
  }
  const linesTotal = priced > 0 ? Number(sum) : null;
  const net = totals.net.value;
  const gross = totals.gross.value;
  if (linesTotal === null || (net === null && gross === null)) {
    return { linesTotal, incomplete, net, gross, state: "unknown", difference: null };
  }
  if (linesTotal === net || linesTotal === gross) {
    return { linesTotal, incomplete, net, gross, state: "match", difference: null };
  }
  return { linesTotal, incomplete, net, gross, state: "mismatch", difference: linesTotal - (net ?? gross!) };
}

/** How many values the API flagged for the person to check (the header counter). */
export function checkCount(state: ReviewState): number {
  let count = state.supplier.warnings.length;
  for (const item of state.header) count += item.warnings.length;
  for (const line of state.lines) {
    for (const codes of Object.values(line.warnings)) count += codes?.length ?? 0;
  }
  return count;
}
