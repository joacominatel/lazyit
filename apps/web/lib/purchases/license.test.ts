import { describe, expect, test } from "bun:test";
import { ApplyLicenseSchema, type LicenseProposal, type PurchaseOrderLine } from "@lazyit/shared";
import { buildApplyLicensePayload, licenseApplyOutcome, licenseApplyPrefill, licenseSeats } from "./license";

const line: PurchaseOrderLine = {
  id: "ckline0000000000000000000",
  purchaseOrderId: "ckpurchase000000000000000",
  position: 0,
  kind: "LICENSE",
  description: "M365 E3",
  manufacturerText: null,
  modelText: null,
  assetModelId: null,
  applicationId: "ckapplication00000000000a",
  quantity: 25,
  unitPrice: null,
  cancelledQuantity: 0,
  warrantyMonths: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  deletedAt: null,
  receivedQuantity: 10,
  pendingQuantity: 15,
  receiptState: "PARTIAL",
  lineTotal: null,
};

const proposal: LicenseProposal = {
  line,
  application: {
    id: "ckapplication00000000000a",
    name: "Microsoft 365",
    seatsPurchased: 40,
    seatsUsed: 38,
    renewalDate: "2026-12-31T00:00:00.000Z",
    deletedAt: null,
  },
  seatsToAdd: 15,
  seatsPurchasedAfter: 55,
  overAppliedAfter: false,
  warnings: [],
};

describe("licenseApplyPrefill", () => {
  test("starts at the line's pending seats and never proposes a renewal date", () => {
    expect(licenseApplyPrefill(proposal)).toEqual({ seatsToAdd: "15", renewalDate: "" });
  });

  test("a line with nothing pending starts blank (a renewal alone is still possible)", () => {
    expect(licenseApplyPrefill({ seatsToAdd: 0 })).toEqual({ seatsToAdd: "", renewalDate: "" });
  });
});

describe("buildApplyLicensePayload — only what the person confirmed", () => {
  test("seats and a renewal date", () => {
    const result = buildApplyLicensePayload({ seatsToAdd: "15", renewalDate: "2027-12-31" });
    expect(result).toEqual({
      ok: true,
      payload: { seatsToAdd: 15, renewalDate: "2027-12-31T00:00:00.000Z" },
    });
    if (result.ok) expect(ApplyLicenseSchema.safeParse(result.payload).success).toBe(true);
  });

  test("seats alone leave the renewal date untouched (absent, not null)", () => {
    expect(buildApplyLicensePayload({ seatsToAdd: " 5 ", renewalDate: "" })).toEqual({
      ok: true,
      payload: { seatsToAdd: 5 },
    });
  });

  test("a renewal alone, with no seats (blank or 0), is a valid apply", () => {
    for (const seats of ["", "0"]) {
      expect(buildApplyLicensePayload({ seatsToAdd: seats, renewalDate: "2027-01-31" })).toEqual({
        ok: true,
        payload: { renewalDate: "2027-01-31T00:00:00.000Z" },
      });
    }
  });

  test("nothing to apply is refused before the request", () => {
    expect(buildApplyLicensePayload({ seatsToAdd: "0", renewalDate: "" })).toEqual({
      ok: false,
      error: "nothingToApply",
    });
  });

  test("a count that is not a whole number is refused, never rounded", () => {
    for (const seats of ["1.5", "-3", "ten", "99999999999"]) {
      expect(buildApplyLicensePayload({ seatsToAdd: seats, renewalDate: "" })).toEqual({
        ok: false,
        error: "seatsInvalid",
      });
    }
    expect(licenseSeats("")).toBe(0);
  });
});

describe("licenseApplyOutcome — the count afterwards and the warnings", () => {
  test("a tracked count grows by the seats added", () => {
    expect(licenseApplyOutcome(proposal, 15)).toEqual({
      seatsAfter: 55,
      untracked: false,
      overApplied: false,
      appliedAfter: 25,
      bought: 25,
    });
  });

  test("applying past what the line bought is flagged, not refused", () => {
    expect(licenseApplyOutcome(proposal, 16)).toMatchObject({ overApplied: true, appliedAfter: 26 });
  });

  test("cancelled seats are not counted as bought", () => {
    const cancelled = { ...proposal, line: { ...line, cancelledQuantity: 5 } };
    expect(licenseApplyOutcome(cancelled, 11)).toMatchObject({ bought: 20, overApplied: true });
  });

  test("an untracked count (unlimited) starts from the seats added", () => {
    const untracked = { ...proposal, application: { ...proposal.application!, seatsPurchased: null } };
    expect(licenseApplyOutcome(untracked, 15)).toMatchObject({ seatsAfter: 15, untracked: true });
  });

  test("without a live application there is no count afterwards", () => {
    expect(licenseApplyOutcome({ ...proposal, application: null }, 15).seatsAfter).toBeNull();
    const archived = { ...proposal, application: { ...proposal.application!, deletedAt: "2026-05-01T00:00:00.000Z" } };
    expect(licenseApplyOutcome(archived, 15)).toMatchObject({ seatsAfter: null, untracked: false });
  });
});
