import { z } from "zod";
import { int4, money } from "./primitives";
import { PurchaseOrderLineKindSchema } from "./purchase-order";

/**
 * Purchase document extraction (ADR-0099 §11, #1477): read a document ALREADY ATTACHED to a purchase and
 * return a DRAFT a person reviews and saves through the normal write path. Extraction never saves anything.
 * It is behind its own AI switch (`AiSettings.documentExtractionEnabled`, OFF by default), needs the
 * assistant enabled and a provider that reads the document's type, and runs with no tools: the document is
 * untrusted content and only ever becomes data in the draft.
 *
 * Blanks over guesses: every field is `{ value, evidence }`, and `value` is `null` whenever the document did
 * not say it plainly — or when what it said could not be read without guessing (an amount whose decimal
 * separator is ambiguous, a date that reads two ways). `evidence` is the verbatim text the value came from
 * and its page, so the reviewer sees what was read (docs/purchases/ux-proposal.md §3.b).
 */

/** The largest document sent for extraction. Smaller than the 25 MB attachment cap: the provider limits bind. */
export const PURCHASE_EXTRACTION_MAX_BYTES = 10 * 1024 * 1024;
/** The most pages of a PDF sent for extraction (counted best-effort from the file's page objects). */
export const PURCHASE_EXTRACTION_MAX_PAGES = 20;
/** The most lines a draft carries; past it the draft is cut and says so (`LINES_TRUNCATED`). */
export const PURCHASE_EXTRACTION_MAX_LINES = 200;

/**
 * Why extraction is not available to this caller right now (`GET /purchase-orders/extraction/status`), and
 * the `code` of the matching `409` on the extract route:
 *   - `AI_DISABLED`          — the assistant is off, not configured, its key does not decrypt, or shim mode;
 *   - `EXTRACTION_DISABLED`  — the *Document extraction* switch is off (the default);
 *   - `PROVIDER_UNSUPPORTED` — the configured provider reads no document type (the OpenAI-compatible one);
 *   - `NOT_PERMITTED`        — the caller may not extract: a service account (extraction is human-only), or a
 *                              person without `purchaseOrder:write` and `ai:use`.
 */
export const PURCHASE_EXTRACTION_UNAVAILABLE_REASONS = [
  "AI_DISABLED",
  "EXTRACTION_DISABLED",
  "PROVIDER_UNSUPPORTED",
  "NOT_PERMITTED",
] as const;
export const PurchaseExtractionUnavailableReasonSchema = z.enum(
  PURCHASE_EXTRACTION_UNAVAILABLE_REASONS,
);

/**
 * `GET /purchase-orders/extraction/status` — whether the *Fill from this document* action can be offered to
 * the caller, and for which document types. `reason` is an open string on read (a newer API may add one; the
 * web shows it generically). `disclosure` is the text Settings → AI shows next to the switch.
 */
export const PurchaseExtractionStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The document types the configured provider reads; empty when extraction is unavailable. */
  mediaTypes: z.array(z.string()),
  maxBytes: int4({ min: 0 }),
  maxPages: int4({ min: 0 }),
  disclosure: z.string(),
});

/**
 * The `code` of every extract refusal, next to its human `message` (the web matches the code):
 *   409 — an unavailable reason above;
 *   422 — `UNSUPPORTED_MEDIA_TYPE` (the provider does not read this document's type), `DOCUMENT_TOO_LARGE`,
 *         `TOO_MANY_PAGES`, `DOCUMENT_UNAVAILABLE` (the stored file is missing);
 *   429 — `BUDGET_EXCEEDED` (the caller's daily AI token budget is spent);
 *   502 — `EXTRACTION_UNREADABLE` (the model answered nothing usable) or a provider code (`PROVIDER_AUTH`,
 *         `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_BAD_REQUEST`, `PROVIDER_REFUSED`,
 *         `EGRESS_DENIED`, `CONTEXT_LIMIT`);
 *   504 — `EXTRACTION_TIMEOUT`.
 * Nothing is saved on any of them; the document stays attached. The list only grows.
 */
export const PURCHASE_EXTRACTION_ERROR_CODES = [
  ...PURCHASE_EXTRACTION_UNAVAILABLE_REASONS,
  "UNSUPPORTED_MEDIA_TYPE",
  "DOCUMENT_TOO_LARGE",
  "TOO_MANY_PAGES",
  "DOCUMENT_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "EXTRACTION_UNREADABLE",
  "EXTRACTION_TIMEOUT",
] as const;

/** Where a value was read: the verbatim text and its page (1-based; null when the model could not say). */
export const ExtractionEvidenceSchema = z.object({
  text: z.string(),
  page: int4({ min: 1 }).nullable(),
});

/** One draft field: the value lazyit read (null = blank, never a guess) and the text it came from. */
const draftField = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    evidence: ExtractionEvidenceSchema.nullable(),
  });

/** The purchase header as read from the document. Dates are ISO datetimes at UTC midnight. */
export const PurchaseExtractionHeaderSchema = z.object({
  supplierName: draftField(z.string()),
  /** The supplier's tax ID as printed (a CUIT, a VAT number…) — the strongest supplier match. */
  supplierTaxId: draftField(z.string()),
  /** The order / PO number the document names — the purchase's `reference`. */
  reference: draftField(z.string()),
  /** The currency as the document prints it (`ARS`, `USD`, `$`) — a free-text label (ADR-0099 §5). */
  currency: draftField(z.string()),
  orderDate: draftField(z.iso.datetime()),
  invoiceNumbers: draftField(z.string()),
  invoiceDate: draftField(z.iso.datetime()),
});

/**
 * One line as read. Amounts are minor units (ADR-0100), parsed by lazyit from the literal text in
 * `evidence` — never a number the model computed. `kind` is the model's reading of what the line is (a
 * device, a consumable, a license, or something else such as shipping); `null` when it could not tell.
 */
export const PurchaseExtractionLineSchema = z.object({
  kind: PurchaseOrderLineKindSchema.nullable(),
  description: draftField(z.string()),
  manufacturerText: draftField(z.string()),
  modelText: draftField(z.string()),
  quantity: draftField(int4({ min: 1 })),
  unitPrice: draftField(money()),
  /** The line total the document prints, used to cross-check quantity × unit price. */
  lineTotal: draftField(money()),
  warrantyMonths: draftField(int4({ min: 0, max: 1200 })),
});

/**
 * The totals self-check, never stored: the sum of the draft lines (quantity × unit price over the lines that
 * have both) against what the document prints. `linesTotal` is null when no line has both.
 */
export const PurchaseExtractionTotalsSchema = z.object({
  linesTotal: money().nullable(),
  /** Lines without a readable quantity or unit price: the lines total leaves them out. */
  incompleteLines: int4({ min: 0 }),
  net: draftField(money()),
  tax: draftField(money()),
  gross: draftField(money()),
});

/** How an existing record was matched. Suggestions only: nothing is created or linked by extraction. */
export const PURCHASE_EXTRACTION_MATCH_KINDS = ["TAX_ID", "NAME", "LINE_MEMORY"] as const;
export const PurchaseExtractionMatchKindSchema = z.enum(PURCHASE_EXTRACTION_MATCH_KINDS);

/**
 * Read-only suggestions against what the instance already has:
 *   - `supplier` — a live supplier with the same tax ID (digits compared), else exactly one with the same
 *     normalized name (case, accents, punctuation and legal suffixes such as "S.A." ignored);
 *   - `lineModels[i]` — for draft line `i`, a live asset model: the one an earlier purchase line with the same
 *     description was mapped to (`LINE_MEMORY`), else exactly one whose manufacturer and name match the
 *     line's brand and model text (`NAME`). `null` when nothing matches or the match is ambiguous.
 */
export const PurchaseExtractionMatchesSchema = z.object({
  supplier: z
    .object({ id: z.cuid(), name: z.string(), by: PurchaseExtractionMatchKindSchema })
    .nullable(),
  lineModels: z.array(
    z
      .object({
        id: z.cuid(),
        name: z.string(),
        manufacturer: z.string(),
        by: PurchaseExtractionMatchKindSchema,
      })
      .nullable(),
  ),
});

/**
 * What the reviewer should check. `path` names the field (`header.invoiceDate`, `lines.2.unitPrice`,
 * `totals`, `lines`):
 *   - `AMOUNT_AMBIGUOUS`    — the amount reads two ways (`1.150`: 1150 or 1.15) and the document gives no other
 *                             amount that settles its decimal separator; left blank;
 *   - `AMOUNT_UNREADABLE`   — the text is not an amount lazyit can read (negative, letters, malformed); blank;
 *   - `AMOUNT_TOO_PRECISE`  — more than two decimals (amounts are stored in hundredths); blank;
 *   - `QUANTITY_NOT_WHOLE`  — a quantity that is not a whole, positive number of units; blank;
 *   - `DATE_AMBIGUOUS`      — a date that reads as day/month and month/day; kept as read by the model, check it;
 *   - `DATE_UNREADABLE`     — the model's date does not match the printed text; blank;
 *   - `CURRENCY_AMBIGUOUS`  — the document prints only a symbol several currencies share (`$`);
 *   - `LINE_TOTAL_MISMATCH` — quantity × unit price differs from the line total the document prints;
 *   - `TOTAL_MISMATCH`      — the lines add up to something other than the document's net and gross;
 *   - `LINES_TRUNCATED`     — the document had more lines than a draft carries.
 * The list only grows; a web shows an unknown code generically.
 */
export const PURCHASE_EXTRACTION_WARNING_CODES = [
  "AMOUNT_AMBIGUOUS",
  "AMOUNT_UNREADABLE",
  "AMOUNT_TOO_PRECISE",
  "QUANTITY_NOT_WHOLE",
  "DATE_AMBIGUOUS",
  "DATE_UNREADABLE",
  "CURRENCY_AMBIGUOUS",
  "LINE_TOTAL_MISMATCH",
  "TOTAL_MISMATCH",
  "LINES_TRUNCATED",
] as const;
export const PurchaseExtractionWarningCodeSchema = z.enum(PURCHASE_EXTRACTION_WARNING_CODES);

export const PurchaseExtractionWarningSchema = z.object({
  /** Open string on read, so an older web renders a newer code generically. */
  code: z.string(),
  path: z.string(),
  /** Numbers that explain it (`TOTAL_MISMATCH`: `linesTotal`, `net`, `gross`), never document text. */
  detail: z.record(z.string(), z.number().nullable()).optional(),
});

/**
 * `POST /purchase-orders/:id/attachments/:attachmentId/extract` — the draft. Nothing was saved: the web
 * opens the review, and the person saves through the purchase's own write routes. `extractionId` is the
 * id the usage row and the purchase's `EXTRACTION_RUN` event carry.
 */
export const PurchaseExtractionDraftSchema = z.object({
  extractionId: z.string(),
  purchaseOrderId: z.cuid(),
  attachmentId: z.cuid(),
  header: PurchaseExtractionHeaderSchema,
  lines: z.array(PurchaseExtractionLineSchema),
  totals: PurchaseExtractionTotalsSchema,
  matches: PurchaseExtractionMatchesSchema,
  warnings: z.array(PurchaseExtractionWarningSchema),
});

export type PurchaseExtractionUnavailableReason = z.infer<
  typeof PurchaseExtractionUnavailableReasonSchema
>;
export type PurchaseExtractionErrorCode = (typeof PURCHASE_EXTRACTION_ERROR_CODES)[number];
export type PurchaseExtractionStatus = z.infer<typeof PurchaseExtractionStatusSchema>;
export type ExtractionEvidence = z.infer<typeof ExtractionEvidenceSchema>;
export type PurchaseExtractionHeader = z.infer<typeof PurchaseExtractionHeaderSchema>;
export type PurchaseExtractionLine = z.infer<typeof PurchaseExtractionLineSchema>;
export type PurchaseExtractionTotals = z.infer<typeof PurchaseExtractionTotalsSchema>;
export type PurchaseExtractionMatchKind = z.infer<typeof PurchaseExtractionMatchKindSchema>;
export type PurchaseExtractionMatches = z.infer<typeof PurchaseExtractionMatchesSchema>;
export type PurchaseExtractionWarningCode = z.infer<typeof PurchaseExtractionWarningCodeSchema>;
export type PurchaseExtractionWarning = z.infer<typeof PurchaseExtractionWarningSchema>;
export type PurchaseExtractionDraft = z.infer<typeof PurchaseExtractionDraftSchema>;
