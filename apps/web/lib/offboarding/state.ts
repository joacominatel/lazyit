/**
 * The loading / error / empty flags of the Offboarding data (issue #601, extended by ADR-0098). Pure so
 * the compliance rule is unit-tested: a failed read collapses its list to empty, so ANY failed read must
 * surface as `isError` — never as "nothing to return" — or the Return Act under-reports.
 *
 * The consumables read has one deliberate exception: a **403** (the operator lacks `consumable:read`,
 * a custom-role edge case — offboarding itself needs `user:manage`) does not fail the whole sheet. The
 * consumables section is omitted with a note (`consumablesUnavailable`), and because what the person
 * holds is then genuinely unknown, `isEmpty` is never claimed.
 */
export function deriveOffboardingState(input: {
  /** Any of the asset / access reads (or the consumables reads) still loading. */
  loading: boolean;
  /** Any of the asset / access / catalog reads failed. */
  coreError: boolean;
  /** A consumables read failed with anything other than a 403. */
  consumablesError: boolean;
  /** A consumables read was refused (403). */
  consumablesForbidden: boolean;
  assetCount: number;
  grantCount: number;
  consumableCount: number;
}): { isLoading: boolean; isError: boolean; isEmpty: boolean; consumablesUnavailable: boolean } {
  const isError = input.coreError || input.consumablesError;
  const consumablesUnavailable = input.consumablesForbidden && !input.consumablesError;
  return {
    isLoading: input.loading,
    isError,
    consumablesUnavailable,
    isEmpty:
      !input.loading &&
      !isError &&
      !consumablesUnavailable &&
      input.assetCount === 0 &&
      input.grantCount === 0 &&
      input.consumableCount === 0,
  };
}
