import {
  CURRENCY_LABEL_MAX_LENGTH,
  MONEY_MAX,
  PURCHASE_EXTRACTION_MAX_LINES,
  type ExtractionEvidence,
  type PurchaseExtractionDraft,
  type PurchaseExtractionLine,
  type PurchaseExtractionWarning,
  type PurchaseExtractionWarningCode,
} from '@lazyit/shared';
import {
  inferDateOrder,
  inferDecimalSeparator,
  readAmount,
  readDate,
  readQuantity,
  type AmountFailure,
  type DateOrder,
  type DecimalSeparator,
} from './document-values';
import type { ExtractionModelOutput } from './extraction-model';

/**
 * The model's transcription → the draft the API returns (#1477). Pure: no I/O, no clock. Every value needs
 * printed evidence (a value the document does not print is a guess, so it is dropped), amounts and
 * quantities are read from their literal text in the document's own number format, dates from their
 * printed text, and every cross-check that fails becomes a warning for the reviewer — never a correction.
 * Matches against existing records are added by the service.
 */

/** The longest evidence text kept: enough to show what was read, not a copy of the document. */
const EVIDENCE_MAX_LENGTH = 500;

/** The draft text values are bounded like the purchase fields they prefill. */
const LIMITS = {
  supplierName: 200,
  supplierTaxId: 50,
  reference: 200,
  invoiceNumbers: 500,
  description: 500,
  manufacturerText: 200,
  modelText: 200,
} as const;

/** Symbols several currencies print the same way: the label is kept, the reviewer is asked to check it. */
const AMBIGUOUS_CURRENCY_SYMBOLS = new Set(['$', '¥', 'kr', 'r$']);

type DraftField<T> = { value: T | null; evidence: ExtractionEvidence | null };
type Transcribed = {
  value: string | null;
  text: string | null;
  page: number | null;
};
type Literal = { text: string | null; page: number | null };

export interface DraftContext {
  extractionId: string;
  purchaseOrderId: string;
  attachmentId: string;
}

/** Output tokens one transcribed line takes, evidence and pages included (a measured upper estimate). */
export const EXTRACTION_TOKENS_PER_LINE = 180;
/** Output tokens the header, the totals and the JSON framing take. */
export const EXTRACTION_FIXED_TOKENS = 1_000;

/**
 * The most lines the model is asked to transcribe under an output cap — so a long document is cut by the
 * model at a line boundary (and says so) instead of running out of tokens mid-JSON, which reads as nothing.
 * 16 000 tokens → 80 lines (`PURCHASE_EXTRACTION_MAX_LINES`, the ceiling); a lower admin cap asks for fewer,
 * never under 10.
 */
export function extractionLineLimit(maxOutputTokens: number): number {
  const fit = Math.floor(
    (maxOutputTokens - EXTRACTION_FIXED_TOKENS) / EXTRACTION_TOKENS_PER_LINE,
  );
  return Math.max(10, Math.min(PURCHASE_EXTRACTION_MAX_LINES, fit));
}

const AMOUNT_WARNING: Record<AmountFailure, PurchaseExtractionWarningCode> = {
  AMBIGUOUS: 'AMOUNT_AMBIGUOUS',
  TOO_PRECISE: 'AMOUNT_TOO_PRECISE',
  UNREADABLE: 'AMOUNT_UNREADABLE',
};

const blank = <T>(): DraftField<T> => ({ value: null, evidence: null });

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** The printed text and page, or null when nothing was printed. */
function evidenceOf(
  text: string | null,
  page: number | null,
): ExtractionEvidence | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return {
    text: clip(trimmed, EVIDENCE_MAX_LENGTH),
    page:
      page !== null && Number.isInteger(page) && page >= 1 && page <= 10_000
        ? page
        : null,
  };
}

/** Builds the draft and collects its warnings. */
class DraftBuilder {
  readonly warnings: PurchaseExtractionWarning[] = [];

  constructor(
    private readonly decimal: DecimalSeparator | null,
    private readonly dateOrder: DateOrder | null,
  ) {}

  warn(
    code: PurchaseExtractionWarningCode,
    path: string,
    detail?: Record<string, number | null>,
  ): void {
    this.warnings.push({ code, path, ...(detail ? { detail } : {}) });
  }

  text(field: Transcribed, max: number): DraftField<string> {
    const evidence = evidenceOf(field.text, field.page);
    if (!evidence) return blank();
    const value = (field.value ?? field.text ?? '').replace(/\s+/g, ' ').trim();
    return { value: value ? clip(value, max) : null, evidence };
  }

  currency(field: Transcribed, path: string): DraftField<string> {
    const read = this.text(field, CURRENCY_LABEL_MAX_LENGTH);
    if (
      read.value !== null &&
      AMBIGUOUS_CURRENCY_SYMBOLS.has(read.value.toLowerCase())
    ) {
      this.warn('CURRENCY_AMBIGUOUS', path);
    }
    return read;
  }

  date(field: Transcribed, path: string): DraftField<string> {
    const evidence = evidenceOf(field.text, field.page);
    if (!evidence) return blank();
    const reading = readDate(evidence.text, field.value, this.dateOrder);
    if (!reading.ok) {
      this.warn(
        reading.reason === 'AMBIGUOUS' ? 'DATE_AMBIGUOUS' : 'DATE_UNREADABLE',
        path,
      );
      return { value: null, evidence };
    }
    return { value: reading.iso, evidence };
  }

  amount(field: Literal, path: string): DraftField<number> {
    const evidence = evidenceOf(field.text, field.page);
    if (!evidence) return blank();
    const reading = readAmount(evidence.text, this.decimal);
    if (!reading.ok) {
      this.warn(AMOUNT_WARNING[reading.reason], path);
      return { value: null, evidence };
    }
    return { value: reading.minor, evidence };
  }

  quantity(field: Literal, path: string): DraftField<number> {
    const evidence = evidenceOf(field.text, field.page);
    if (!evidence) return blank();
    const reading = readQuantity(evidence.text, this.decimal);
    if (!reading.ok) {
      this.warn(
        reading.reason === 'NOT_WHOLE'
          ? 'QUANTITY_NOT_WHOLE'
          : AMOUNT_WARNING[reading.reason],
        path,
      );
      return { value: null, evidence };
    }
    return { value: reading.quantity, evidence };
  }

  months(field: {
    value: number | null;
    text: string | null;
    page: number | null;
  }): DraftField<number> {
    const evidence = evidenceOf(field.text, field.page);
    const value = field.value;
    if (
      !evidence ||
      value === null ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 1200
    ) {
      return blank();
    }
    return { value, evidence };
  }
}

/** quantity × unit price, exactly, or null when either is missing or the product passes `MONEY_MAX`. */
function product(line: PurchaseExtractionLine): bigint | null {
  if (line.quantity.value === null || line.unitPrice.value === null)
    return null;
  const total = BigInt(line.quantity.value) * BigInt(line.unitPrice.value);
  return total > BigInt(MONEY_MAX) ? null : total;
}

export function buildDraft(
  output: ExtractionModelOutput,
  context: DraftContext,
  maxLines: number = PURCHASE_EXTRACTION_MAX_LINES,
): Omit<PurchaseExtractionDraft, 'matches'> {
  const { header, totals } = output;
  const decimal = inferDecimalSeparator([
    ...output.lines.flatMap((line) => [
      line.quantity.text,
      line.unitPrice.text,
      line.lineTotal.text,
    ]),
    totals.net.text,
    totals.tax.text,
    totals.gross.text,
  ]);
  const dateOrder = inferDateOrder([
    header.orderDate.text,
    header.invoiceDate.text,
  ]);
  const b = new DraftBuilder(decimal, dateOrder);

  const draftHeader = {
    supplierName: b.text(header.supplierName, LIMITS.supplierName),
    supplierTaxId: b.text(header.supplierTaxId, LIMITS.supplierTaxId),
    reference: b.text(header.reference, LIMITS.reference),
    currency: b.currency(header.currency, 'header.currency'),
    orderDate: b.date(header.orderDate, 'header.orderDate'),
    invoiceNumbers: b.text(header.invoiceNumbers, LIMITS.invoiceNumbers),
    invoiceDate: b.date(header.invoiceDate, 'header.invoiceDate'),
  };

  const kept = output.lines.slice(0, maxLines);
  // The model was asked for at most `maxLines` and to say when the document has more.
  if (output.lines.length > kept.length || output.moreLines === true) {
    b.warn('LINES_TRUNCATED', 'lines', {
      lines: output.lines.length,
      kept: kept.length,
    });
  }
  const lines: PurchaseExtractionLine[] = kept.map((line, index) => {
    const path = `lines.${index}`;
    const draftLine: PurchaseExtractionLine = {
      kind: line.kind,
      description: b.text(line.description, LIMITS.description),
      manufacturerText: b.text(line.manufacturer, LIMITS.manufacturerText),
      modelText: b.text(line.model, LIMITS.modelText),
      quantity: b.quantity(line.quantity, `${path}.quantity`),
      unitPrice: b.amount(line.unitPrice, `${path}.unitPrice`),
      lineTotal: b.amount(line.lineTotal, `${path}.lineTotal`),
      warrantyMonths: b.months(line.warrantyMonths),
    };
    const expected = product(draftLine);
    if (
      expected !== null &&
      draftLine.lineTotal.value !== null &&
      expected !== BigInt(draftLine.lineTotal.value)
    ) {
      b.warn('LINE_TOTAL_MISMATCH', `${path}.lineTotal`, {
        expected: Number(expected),
        printed: draftLine.lineTotal.value,
      });
    }
    return draftLine;
  });

  const net = b.amount(totals.net, 'totals.net');
  const tax = b.amount(totals.tax, 'totals.tax');
  const gross = b.amount(totals.gross, 'totals.gross');
  let sum = 0n;
  let counted = 0;
  for (const line of lines) {
    const total = product(line);
    if (total === null) continue;
    sum += total;
    counted += 1;
  }
  const linesTotal =
    counted > 0 && sum <= BigInt(MONEY_MAX) ? Number(sum) : null;
  const printed = [net.value, gross.value].filter(
    (value): value is number => value !== null,
  );
  // Only a complete sum is compared: with a line missing its quantity or price the gap is expected, and the
  // reviewer already sees that line blank.
  if (
    linesTotal !== null &&
    counted === lines.length &&
    printed.length > 0 &&
    !printed.includes(linesTotal)
  ) {
    b.warn('TOTAL_MISMATCH', 'totals', {
      linesTotal,
      net: net.value,
      gross: gross.value,
    });
  }

  return {
    extractionId: context.extractionId,
    purchaseOrderId: context.purchaseOrderId,
    attachmentId: context.attachmentId,
    header: draftHeader,
    lines,
    totals: {
      linesTotal,
      incompleteLines: lines.length - counted,
      net,
      tax,
      gross,
    },
    warnings: b.warnings,
  };
}
