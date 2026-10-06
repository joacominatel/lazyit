/**
 * Applying a `LICENSE` line to its application (ADR-0099 Phase 2, #1477) — the dialog's text → the
 * `POST /purchase-orders/:id/lines/:lineId/apply-license` body, and what applying it would do. Pure, so it is
 * tested without React.
 *
 * Nothing changes an application's seats on its own: the proposal is read, the person edits the seats to add
 * and types the renewal date (never proposed — the term is not on the line), and only the confirmed values are
 * sent. Applying more seats than the line bought is allowed and only warned about (`OVER_APPLIED`, §4).
 */

import { type ApplyLicense, ApplyLicenseSchema, type LicenseProposal } from "@lazyit/shared";
import { dateInputToIso } from "./payload";

/** The dialog's raw state: text as typed. */
export interface LicenseApplyForm {
  /** Digits; blank (or 0) = add no seats, only the renewal. */
  seatsToAdd: string;
  /** `"YYYY-MM-DD"` or `""` (blank = leave the application's renewal date as it is). */
  renewalDate: string;
}

/** Why the form cannot be sent yet. */
export type LicenseApplyError = "seatsInvalid" | "nothingToApply";

/** The form a proposal opens with: the line's pending seats, and no renewal date (the operator types it). */
export function licenseApplyPrefill(proposal: Pick<LicenseProposal, "seatsToAdd">): LicenseApplyForm {
  return { seatsToAdd: proposal.seatsToAdd > 0 ? String(proposal.seatsToAdd) : "", renewalDate: "" };
}

/** The seats typed, as a count: `0` when blank, `null` when not a whole number. */
export function licenseSeats(text: string): number | null {
  const value = text.trim();
  if (value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * The request body: the seats when there are any, the renewal date when one was typed; at least one of the
 * two (the API refuses an empty apply). The schema bounds the seats (int4) and the date.
 */
export function buildApplyLicensePayload(
  form: LicenseApplyForm,
): { ok: true; payload: ApplyLicense } | { ok: false; error: LicenseApplyError } {
  const seats = licenseSeats(form.seatsToAdd);
  if (seats === null) return { ok: false, error: "seatsInvalid" };
  const renewalDate = dateInputToIso(form.renewalDate.trim());
  const body: ApplyLicense = {};
  if (seats > 0) body.seatsToAdd = seats;
  if (renewalDate !== undefined) body.renewalDate = renewalDate;
  if (body.seatsToAdd === undefined && body.renewalDate === undefined) {
    return { ok: false, error: "nothingToApply" };
  }
  const parsed = ApplyLicenseSchema.safeParse(body);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, error: "seatsInvalid" };
}

/**
 * What applying `seatsToAdd` would leave, recomputed as the operator edits the count: the application's
 * seat count afterwards (an untracked count — `seatsPurchased` null — starts from the seats added, the
 * `SEATS_UNTRACKED` case), and whether the line would then have more seats applied than it bought.
 * `seatsAfter` is `null` while the line has no live application.
 */
export function licenseApplyOutcome(
  proposal: Pick<LicenseProposal, "line" | "application">,
  seatsToAdd: number,
): { seatsAfter: number | null; untracked: boolean; overApplied: boolean; appliedAfter: number; bought: number } {
  const { line, application } = proposal;
  const live = application !== null && application.deletedAt === null;
  const untracked = live && application.seatsPurchased === null;
  const seatsAfter = live ? (application.seatsPurchased ?? 0) + seatsToAdd : null;
  const bought = line.quantity - line.cancelledQuantity;
  const appliedAfter = line.receivedQuantity + seatsToAdd;
  return { seatsAfter, untracked, overApplied: appliedAfter > bought, appliedAfter, bought };
}
