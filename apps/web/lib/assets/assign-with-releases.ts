import type { AssetAssignment, AssetListItem } from "@lazyit/shared";

/**
 * The "swap" step of assigning an asset (#1726): while the operator assigns an asset to a person, the
 * assign UI lists what that person already holds and lets them mark held assets to release. Nothing is
 * sent until Assign is pressed; then the new assignment is created FIRST and the marked releases follow.
 * Cancel sends nothing. This module is the pure core of that flow, so the UI stays thin and the order,
 * the skip-on-failure rule and the per-item report are tested without a DOM (ADR-0012).
 */

/** One asset the picked person holds right now — an ACTIVE assignment plus the asset's list row. */
export interface HeldAssetRow {
  assignmentId: string;
  assetId: string;
  assignedAt: string;
  /** The asset's list row (name, tag, model, status), when the asset read resolved it. */
  asset?: AssetListItem;
}

/**
 * The held-assets rows: the person's ACTIVE assignments (the source of truth for "holds"), newest
 * first as the API returns them, each joined to its asset row. The asset being assigned is excluded
 * (it cannot be one the operator releases in the same step). A released row is dropped defensively,
 * even though the read is active-only.
 */
export function heldAssetRows(
  assignments: readonly AssetAssignment[] | undefined,
  assets: readonly AssetListItem[] | undefined,
  excludeAssetId?: string,
): HeldAssetRow[] {
  const byId = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  return (assignments ?? [])
    .filter((a) => a.releasedAt === null && a.assetId !== excludeAssetId)
    .map((a) => ({
      assignmentId: a.id,
      assetId: a.assetId,
      assignedAt: a.assignedAt,
      asset: byId.get(a.assetId),
    }));
}

/** Toggle one held assignment in the set marked for release. */
export function toggleMarked(marked: readonly string[], assignmentId: string): string[] {
  return marked.includes(assignmentId)
    ? marked.filter((id) => id !== assignmentId)
    : [...marked, assignmentId];
}

/**
 * What the operator has marked so far: the held assignments to release and the ONE optional release
 * note shared by all of them (a release note overwrites the assignment's note — see the AssetAssignment
 * note — so one line such as "returned for a replacement" is what a swap needs). Local UI state only:
 * nothing here is sent until Assign.
 */
export interface ReleaseMarks {
  marked: string[];
  note: string;
}

export const NO_RELEASE_MARKS: ReleaseMarks = { marked: [], note: "" };

export type ReleaseMarksAction =
  | { type: "toggle"; assignmentId: string }
  | { type: "note"; note: string }
  /** A different person was picked: marks only ever apply to the person shown. */
  | { type: "pick" }
  /** The step closed without assigning (Cancel, the X, Escape, the overlay): drop everything. */
  | { type: "close" };

export function releaseMarksReducer(
  state: ReleaseMarks,
  action: ReleaseMarksAction,
): ReleaseMarks {
  switch (action.type) {
    case "toggle":
      return { ...state, marked: toggleMarked(state.marked, action.assignmentId) };
    case "note":
      return { ...state, note: action.note };
    case "pick":
    case "close":
      return NO_RELEASE_MARKS;
  }
}

/**
 * Keep only the marks that still name a listed row, in the order the rows are shown. A row that left
 * the list (released elsewhere, the read refetched) is never released by a stale mark.
 */
export function markedRows(rows: readonly HeldAssetRow[], marked: readonly string[]): HeldAssetRow[] {
  const set = new Set(marked);
  return rows.filter((row) => set.has(row.assignmentId));
}

export interface ReleaseResult {
  assignmentId: string;
  assetId: string;
  /** The thrown error when the release failed; absent when it succeeded. */
  error?: unknown;
}

export type AssignWithReleasesOutcome =
  /** The new assignment failed, so no release was attempted — the marks stay for a retry. */
  | { kind: "assign-failed"; error: unknown }
  /** The new assignment succeeded; each marked release reports on its own. */
  | { kind: "assigned"; released: ReleaseResult[]; failed: ReleaseResult[] };

/**
 * Create the new assignment, then release each marked one, in that order (CEO decision on #1726).
 *
 * - If the new assignment fails, NO release is sent: the releases are the other half of a swap the
 *   operator has not completed, and releasing first would leave the person holding neither.
 * - The releases run one after another, in the order given, and one failing does not stop the rest.
 *   Each result is reported, so nothing is silently dropped.
 * - `note`, when given (trimmed, non-empty), is sent with every release — one shared release note.
 */
export async function assignWithReleases({
  assign,
  release,
  releases,
  note,
}: {
  assign: () => Promise<unknown>;
  release: (assignmentId: string, data: { notes?: string }) => Promise<unknown>;
  releases: readonly Pick<HeldAssetRow, "assignmentId" | "assetId">[];
  note?: string;
}): Promise<AssignWithReleasesOutcome> {
  try {
    await assign();
  } catch (error) {
    return { kind: "assign-failed", error };
  }
  const trimmed = note?.trim();
  const data = trimmed ? { notes: trimmed } : {};
  const released: ReleaseResult[] = [];
  const failed: ReleaseResult[] = [];
  for (const { assignmentId, assetId } of releases) {
    try {
      await release(assignmentId, data);
      released.push({ assignmentId, assetId });
    } catch (error) {
      failed.push({ assignmentId, assetId, error });
    }
  }
  return { kind: "assigned", released, failed };
}

/** The human line for an asset in a report: "TAG · Name", or the name alone, or the fallback. */
export function heldAssetLabel(row: HeldAssetRow | undefined, fallback: string): string {
  const asset = row?.asset;
  if (!asset) return fallback;
  return asset.assetTag ? `${asset.assetTag} · ${asset.name}` : asset.name;
}

/** The API's message for a failed release (an `ApiError` carries it), else the fallback. */
export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface ReleaseReportItem {
  key: string;
  label: string;
  /** The reason a release failed; absent on a success. */
  message?: string;
}

/**
 * The per-item report of the releases that followed a successful assignment: which held assets were
 * released and which were not (with the API's reason). Labels come from the rows the operator saw.
 */
export function releaseReport(
  outcome: Extract<AssignWithReleasesOutcome, { kind: "assigned" }>,
  rows: readonly HeldAssetRow[],
  fallbackLabel: string,
  fallbackError: string,
): { released: ReleaseReportItem[]; failed: ReleaseReportItem[] } {
  const byAssignment = new Map(rows.map((row) => [row.assignmentId, row]));
  const label = (id: string) => heldAssetLabel(byAssignment.get(id), fallbackLabel);
  return {
    released: outcome.released.map((r) => ({ key: r.assignmentId, label: label(r.assignmentId) })),
    failed: outcome.failed.map((r) => ({
      key: r.assignmentId,
      label: label(r.assignmentId),
      message: failureMessage(r.error, fallbackError),
    })),
  };
}
