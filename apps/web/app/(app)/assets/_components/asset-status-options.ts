import {
  type AssetStatus,
  type AssetStatusLabelRef,
  AssetStatusSchema,
} from "@lazyit/shared";

/**
 * Pure logic of the asset status picker (ADR-0101, #1524) — the grouping, the value encoding and the
 * wire fields, kept out of React so they can be unit-tested. Every status picker (the asset form, the
 * row and detail menus, the bulk action, the receive dialog, the list filter) goes through this module.
 *
 * The model: an asset's status is a built-in `AssetStatus`, optionally NAMED by one custom status (a
 * label) whose `kind` is that built-in status. So a choice is a pair `{ status, labelId }`, and the
 * options are grouped by built-in status: the bare built-in first, then its custom statuses.
 */

/** The custom-status fields a picker option needs (the list row and the asset's inline ref both fit). */
export type StatusLabelOption = AssetStatusLabelRef & { order?: number | null };

/** One choice: a built-in status, optionally named by a custom status of that kind. */
export interface StatusChoice {
  status: AssetStatus;
  labelId: string | null;
}

/** A built-in status and the custom statuses mapped to it, in display order. */
export interface StatusOptionGroup {
  status: AssetStatus;
  labels: StatusLabelOption[];
}

/** The built-in status of a choice value, e.g. `status:IN_STORAGE`. */
const STATUS_PREFIX = "status:";
/** A custom status choice value, e.g. `label:clx…`. */
const LABEL_PREFIX = "label:";

function compareLabels(a: StatusLabelOption, b: StatusLabelOption): number {
  // `order` ascending with unset last, then name — the API's own order, re-applied so an extra option
  // (the asset's current custom status, when the list cannot be read) lands in its place.
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Group the custom statuses under their built-in status, in the `AssetStatus` declaration order. Every
 * built-in status gets a group, labelled or not. `extra` (the asset's current custom status) is added when
 * the list does not hold it — e.g. a viewer without `category:read` — so the current value always has an
 * option to show.
 */
export function groupStatusOptions(
  labels: readonly StatusLabelOption[] | undefined,
  extra?: StatusLabelOption | null,
): StatusOptionGroup[] {
  const all = [...(labels ?? [])];
  if (extra && !all.some((label) => label.id === extra.id)) all.push(extra);
  return AssetStatusSchema.options.map((status) => ({
    status,
    labels: all.filter((label) => label.kind === status).sort(compareLabels),
  }));
}

/** True when at least one group holds a custom status (otherwise the picker is a flat built-in list). */
export function hasCustomStatuses(groups: readonly StatusOptionGroup[]): boolean {
  return groups.some((group) => group.labels.length > 0);
}

/** A choice → the string a Select / radio group carries. */
export function encodeStatusChoice(choice: StatusChoice): string {
  return choice.labelId
    ? `${LABEL_PREFIX}${choice.labelId}`
    : `${STATUS_PREFIX}${choice.status}`;
}

/**
 * The string a Select / radio group carries → the choice, or `null` for a value that names no option
 * (an unknown built-in status, or a custom status not among `groups`). A custom status takes its kind.
 */
export function decodeStatusChoice(
  value: string,
  groups: readonly StatusOptionGroup[],
): StatusChoice | null {
  if (value.startsWith(STATUS_PREFIX)) {
    const parsed = AssetStatusSchema.safeParse(value.slice(STATUS_PREFIX.length));
    return parsed.success ? { status: parsed.data, labelId: null } : null;
  }
  if (value.startsWith(LABEL_PREFIX)) {
    const id = value.slice(LABEL_PREFIX.length);
    for (const group of groups) {
      if (group.labels.some((label) => label.id === id)) {
        return { status: group.status, labelId: id };
      }
    }
  }
  return null;
}

/** An asset's current choice. Reads tolerate an asset that predates custom statuses (no label keys). */
export function choiceOf(asset: {
  status: AssetStatus;
  statusLabelId?: string | null;
  statusLabel?: { id: string } | null;
}): StatusChoice {
  return {
    status: asset.status,
    labelId: asset.statusLabelId ?? asset.statusLabel?.id ?? null,
  };
}

export function sameChoice(a: StatusChoice, b: StatusChoice): boolean {
  return a.status === b.status && a.labelId === b.labelId;
}

/** The custom status a choice names, looked up in `groups` (null for a bare built-in status). */
export function labelOfChoice(
  choice: StatusChoice,
  groups: readonly StatusOptionGroup[],
): StatusLabelOption | null {
  if (!choice.labelId) return null;
  const group = groups.find((g) => g.status === choice.status);
  return group?.labels.find((label) => label.id === choice.labelId) ?? null;
}

/**
 * The status fields of a CREATE (asset create, bulk receive, receive from a purchase line): a custom
 * status sends its id together with its kind (they agree, so the API accepts both); a bare built-in status
 * sends the status alone.
 */
export function createStatusFields(choice: StatusChoice): {
  status: AssetStatus;
  statusLabelId?: string;
} {
  return choice.labelId
    ? { status: choice.status, statusLabelId: choice.labelId }
    : { status: choice.status };
}

/**
 * The status fields of an UPDATE (`PATCH /assets/:id`): a bare built-in status sends
 * `statusLabelId: null`, so choosing "In storage" on an asset labelled "Loaner pool" (also in storage)
 * really drops the custom status — a `status` alone would keep it, since it maps to the same status.
 */
export function updateStatusFields(choice: StatusChoice): {
  status: AssetStatus;
  statusLabelId: string | null;
} {
  return { status: choice.status, statusLabelId: choice.labelId };
}

/**
 * The status fields of the bulk status action (`POST /assets/batch/status`): a custom status sends its id
 * (the API derives the kind), a built-in status the status plus `statusLabelId: null` — the BARE status, so
 * an asset already in that status but carrying a custom one has its custom status cleared, not skipped.
 */
export function batchStatusFields(
  choice: StatusChoice,
): { status: AssetStatus; statusLabelId: null } | { statusLabelId: string } {
  return choice.labelId
    ? { statusLabelId: choice.labelId }
    : { status: choice.status, statusLabelId: null };
}

/** A custom status colour safe to paint (`#RRGGBB`), or null. The read shape is a free string. */
export function safeLabelColor(color: string | null | undefined): string | null {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}
