import {
  type OffboardConsumableRow,
  type OffboardConsumables,
  selectOffboardConsumables,
} from "./consumables";
import type { OffboardAssetRow, OffboardGrantRow } from "./use-offboarding-data";

/**
 * The two summaries the Offboarding sheet draws from the resolved data (#1532): the impact tiles and
 * the live preview of the printed Return Act. Pure, so the rules are unit-tested and the sheet stays a
 * layout.
 *
 * The preview mirrors the act page's own inclusion rules (`app/(print)/users/[id]/offboarding/act`) —
 * which sections print, and that a consumables group with nothing kept is omitted — so what the
 * operator sees beside the confirm button is what the paper will say. It is a summary, not a copy:
 * each section is capped and the rest is counted.
 */

/** A count the sheet cannot state yet (still loading, a failed read, or a refused read). */
export type ImpactCount = number | null;

export interface OffboardingImpact {
  /** Assets released (active assignments). */
  assets: ImpactCount;
  /** Access grants revoked. */
  access: ImpactCount;
  /** Returnable consumable deliveries still out — what to ask back (ADR-0098). */
  consumables: ImpactCount;
}

/**
 * The impact tile counts. Unknown is `null`, never `0`: a failed read collapses its list to empty
 * (issue #601), so "0 assets released" on an error would under-report. The consumables count is also
 * unknown when the operator may not read consumables (a 403 — `consumablesUnavailable`). Unfetched
 * outstanding deliveries (beyond the read's page) are counted in.
 */
export function offboardingImpact(input: {
  isLoading: boolean;
  isError: boolean;
  consumablesUnavailable: boolean;
  assetCount: number;
  grantCount: number;
  consumables: Pick<OffboardConsumables, "toReturn" | "toReturnMore">;
}): OffboardingImpact {
  if (input.isLoading || input.isError) {
    return { assets: null, access: null, consumables: null };
  }
  return {
    assets: input.assetCount,
    access: input.grantCount,
    consumables: input.consumablesUnavailable
      ? null
      : input.consumables.toReturn.length + input.consumables.toReturnMore,
  };
}

/** How many rows of each section the act preview lists before saying "+N more". */
export const ACT_PREVIEW_MAX_ROWS = 3;

export type ActPreviewSection =
  | { kind: "assets"; rows: OffboardAssetRow[]; more: number }
  | { kind: "access"; rows: OffboardGrantRow[]; more: number }
  | {
      kind: "consumablesToReturn" | "consumablesDelivered";
      rows: OffboardConsumableRow[];
      more: number;
    };

function capped<T>(rows: T[], extra: number, max: number): { rows: T[]; more: number } {
  const shown = rows.slice(0, Math.max(0, max));
  return { rows: shown, more: rows.length - shown.length + Math.max(0, extra) };
}

/**
 * The sections the printed act will carry, in print order, given the act settings and the per-row
 * consumable exclusions:
 *  - assets / access print whenever their toggle is on — an empty one still prints its "nothing to
 *    return" line, so it is still a section here (with no rows);
 *  - consumables print only when toggled on, readable (no 403), and something was kept — each group
 *    also shows when only unfetched rows remain, so its "…and N more" is never lost (as on the act).
 */
export function actPreviewSections(
  input: {
    assets: OffboardAssetRow[];
    grants: OffboardGrantRow[];
    consumables: OffboardConsumables;
    excluded: ReadonlySet<number>;
    consumablesUnavailable: boolean;
    show: { assets: boolean; access: boolean; consumables: boolean };
  },
  maxRows: number = ACT_PREVIEW_MAX_ROWS,
): ActPreviewSection[] {
  const sections: ActPreviewSection[] = [];
  if (input.show.assets) {
    sections.push({ kind: "assets", ...capped(input.assets, 0, maxRows) });
  }
  if (input.show.access) {
    sections.push({ kind: "access", ...capped(input.grants, 0, maxRows) });
  }
  if (input.show.consumables && !input.consumablesUnavailable) {
    const { toReturnMore, deliveredMore } = input.consumables;
    const selected = selectOffboardConsumables(input.consumables, input.excluded);
    if (selected.toReturn.length > 0 || toReturnMore > 0) {
      sections.push({
        kind: "consumablesToReturn",
        ...capped(selected.toReturn, toReturnMore, maxRows),
      });
    }
    if (selected.delivered.length > 0 || deliveredMore > 0) {
      sections.push({
        kind: "consumablesDelivered",
        ...capped(selected.delivered, deliveredMore, maxRows),
      });
    }
  }
  return sections;
}
