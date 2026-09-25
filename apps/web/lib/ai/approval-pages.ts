import type { AiMessagePart } from "@lazyit/shared";
import type { DecisionErrorKind } from "./error-kinds";
import { STEP_UP_WARNINGS } from "./error-kinds";
import { groupMessageParts, type MessageItem, type ToolPart } from "./tool-groups";

/**
 * Several changes at once (issue #1409). A step that proposes more than one change shows ONE paged
 * approval card — "1 of 5", previous / next — instead of a stack of cards, and the calls the server
 * refused before they became a proposal (the sixth and later of a step, an invalid input…) collapse into
 * one line. Everything here is pure; the pager component holds the state and calls these.
 */

export type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

/** A message's render items: the #1377 items plus the paged card and the collapsed refusals. */
export type PlannedItem =
  | MessageItem
  | { kind: "approvals"; parts: ApprovalPart[]; index: number }
  | { kind: "refused"; parts: ToolPart[]; index: number };

/** Below this many refused calls each keeps its own line, as before. */
export const REFUSED_COLLAPSE_MIN = 2;
/** Below this many cards in one step each keeps its own card, as before. */
export const PAGED_MIN = 2;

/** A write the server refused before it became a proposal: it failed and no card stands for it. */
function isRefusedWrite(part: ToolPart, carded: ReadonlySet<string>): boolean {
  return (
    (part.class === "write" || part.class === "elevated") &&
    (part.status === "FAILED" || part.status === "DENIED") &&
    !carded.has(part.toolCallId)
  );
}

/**
 * The message's parts as render items. A run of consecutive tool lines and cards (one step's calls) with
 * two or more cards waiting on the user (not auto-approved) becomes one `approvals` item at the first
 * card, and those cards' own tool lines are dropped (the page shows their result). Two or more refused
 * writes anywhere in the message become one `refused` item at the first. Everything else is unchanged —
 * text, notices, forms, auto-approved records, and the #1377 collapsing of repeated reads.
 */
export function planMessageParts(parts: readonly AiMessagePart[]): PlannedItem[] {
  const carded = new Set(
    parts.flatMap((p) => (p.type === "approval" ? [p.request.toolCallId] : [])),
  );
  const skip = new Set<number>();
  const inserts = new Map<number, PlannedItem>();

  // One step's calls: a maximal run of tool lines and cards, nothing else in between.
  let start = 0;
  while (start < parts.length) {
    if (parts[start]!.type !== "tool" && parts[start]!.type !== "approval") {
      start++;
      continue;
    }
    let end = start;
    while (end < parts.length && (parts[end]!.type === "tool" || parts[end]!.type === "approval")) end++;
    const cards: { part: ApprovalPart; index: number }[] = [];
    for (let i = start; i < end; i++) {
      const p = parts[i]!;
      if (p.type === "approval" && p.auto !== true) cards.push({ part: p, index: i });
    }
    if (cards.length >= PAGED_MIN) {
      const ids = new Set(cards.map((c) => c.part.request.toolCallId));
      for (let i = start; i < end; i++) {
        const p = parts[i]!;
        if (p.type === "tool" && ids.has(p.toolCallId)) skip.add(i);
      }
      for (const c of cards) skip.add(c.index);
      inserts.set(cards[0]!.index, {
        kind: "approvals",
        parts: cards.map((c) => c.part),
        index: cards[0]!.index,
      });
    }
    start = end;
  }

  const refused: { part: ToolPart; index: number }[] = [];
  parts.forEach((p, i) => {
    if (p.type === "tool" && !skip.has(i) && isRefusedWrite(p, carded)) refused.push({ part: p, index: i });
  });
  if (refused.length >= REFUSED_COLLAPSE_MIN) {
    for (const r of refused) skip.add(r.index);
    inserts.set(refused[0]!.index, {
      kind: "refused",
      parts: refused.map((r) => r.part),
      index: refused[0]!.index,
    });
  }

  if (inserts.size === 0) return groupMessageParts(parts);

  // Keep the #1377 collapsing for what is left: group each stretch between synthetic items on its own,
  // re-indexed to the original positions.
  const out: PlannedItem[] = [];
  let stretch: { part: AiMessagePart; index: number }[] = [];
  const flush = () => {
    if (stretch.length === 0) return;
    const indexes = stretch.map((s) => s.index);
    for (const item of groupMessageParts(stretch.map((s) => s.part))) {
      out.push({ ...item, index: indexes[item.index]! });
    }
    stretch = [];
  };
  parts.forEach((part, index) => {
    const insert = inserts.get(index);
    if (insert) {
      flush();
      out.push(insert);
    }
    if (!skip.has(index)) stretch.push({ part, index });
  });
  flush();
  return out;
}

/* ─── The pager ─────────────────────────────────────────────────────────────────────────────────── */

/** What the pager knows beyond the parts: decisions accepted but not yet echoed, and failed attempts. */
export interface PagerState {
  /** Decisions the server accepted whose `approval_resolved` has not arrived yet. */
  accepted: Readonly<Record<string, "approve" | "reject">>;
  /** The last refusal of a decision on a card, by call id; cleared by the next accepted decision. */
  errors: Readonly<Record<string, DecisionErrorKind>>;
}

export const EMPTY_PAGER_STATE: PagerState = { accepted: {}, errors: {} };

/** Records a decision's answer: accepted (and its error cleared) or refused. Pure. */
export function recordDecision(
  state: PagerState,
  toolCallId: string,
  decision: "approve" | "reject",
  result: { ok: true } | { ok: false; error: DecisionErrorKind },
): PagerState {
  if (result.ok) {
    const errors = { ...state.errors };
    delete errors[toolCallId];
    return { accepted: { ...state.accepted, [toolCallId]: decision }, errors };
  }
  return { ...state, errors: { ...state.errors, [toolCallId]: result.error } };
}

/** Still waiting on the user: no outcome from the server and no accepted decision in flight. */
export function isUndecided(part: ApprovalPart, state: PagerState): boolean {
  return part.outcome === null && state.accepted[part.request.toolCallId] === undefined;
}

/** The page to open on: the first change still waiting, or the first page when all are decided. */
export function initialPage(parts: readonly ApprovalPart[], state: PagerState = EMPTY_PAGER_STATE): number {
  const at = parts.findIndex((p) => isUndecided(p, state));
  return at === -1 ? 0 : at;
}

/**
 * The next page still waiting after `from`, wrapping around to the start; -1 when none is left. `from`
 * itself only counts when it is the only one left (it is re-checked last).
 */
export function nextUndecided(
  parts: readonly ApprovalPart[],
  from: number,
  state: PagerState,
): number {
  const n = parts.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (isUndecided(parts[i]!, state)) return i;
  }
  return -1;
}

/** A page index kept inside the pages. */
export function clampPage(page: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(page, 0), count - 1);
}

/**
 * Why a change is left out of "Approve all" / "Reject all" — each must be decided on its own page:
 * - `stepUp`: it needs the user's password (the server asks for it, or a step-up warning is on it —
 *   roles, identity, privileges, credentials, a critical application);
 * - `elevated`: a sensitive change (security.md G4 — no batch approval of elevated cards);
 * - `untrusted`: proposed after reading content other people wrote (the same rule that keeps it out of
 *   auto-approve, #1376);
 * - `needsReview`: a decision on it was refused (STALE, preview changed, expired…) — the page shows why.
 */
export type BulkExclusion = "stepUp" | "elevated" | "untrusted" | "needsReview";

export const BULK_EXCLUSIONS: readonly BulkExclusion[] = ["stepUp", "elevated", "untrusted", "needsReview"];

/** Why a still-waiting change can't be decided in bulk, or null when it can. Pure. */
export function bulkExclusion(part: ApprovalPart, state: PagerState): BulkExclusion | null {
  const { request } = part;
  const { preview } = request;
  if (
    request.stepUpRequired ||
    preview.stepUpRequired ||
    preview.warnings.some((code) => STEP_UP_WARNINGS.includes(code))
  ) {
    return "stepUp";
  }
  if (request.elevated || preview.elevated || preview.class === "elevated") return "elevated";
  if (request.untrustedSources.length > 0 || preview.untrustedSources.length > 0) return "untrusted";
  if (state.errors[request.toolCallId] !== undefined) return "needsReview";
  return null;
}

export interface BulkPlan {
  /** The call ids "Approve all" / "Reject all" would decide, in page order. */
  eligible: string[];
  /** How many still-waiting changes are left out, per reason (only reasons with a count). */
  excluded: { reason: BulkExclusion; count: number }[];
  /** How many changes are still waiting in total. */
  waiting: number;
}

/** What a bulk action would cover. Only changes still waiting are counted. Pure. */
export function bulkPlan(parts: readonly ApprovalPart[], state: PagerState): BulkPlan {
  const eligible: string[] = [];
  const counts = new Map<BulkExclusion, number>();
  let waiting = 0;
  for (const part of parts) {
    if (!isUndecided(part, state)) continue;
    waiting++;
    const reason = bulkExclusion(part, state);
    if (reason === null) eligible.push(part.request.toolCallId);
    else counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return {
    eligible,
    excluded: BULK_EXCLUSIONS.filter((r) => counts.has(r)).map((reason) => ({
      reason,
      count: counts.get(reason)!,
    })),
    waiting,
  };
}

/** Decision refusals after which the rest of a bulk action would fail the same way: stop there. */
export function stopsBulk(kind: DecisionErrorKind): boolean {
  return kind.kind === "notAwaiting" || kind.kind === "aiDisabled" || kind.kind === "forbidden";
}

/** A bulk action's result, for the line under the pager. */
export interface BulkReport {
  decision: "approve" | "reject";
  done: number;
  failed: { toolCallId: string; error: DecisionErrorKind }[];
  /** Left untried after a refusal that stops the rest. */
  skipped: number;
}

/* ─── Refused calls ─────────────────────────────────────────────────────────────────────────────── */

/** The refused calls grouped by tool and reason, most frequent first, for "Show details". Pure. */
export function refusedDetails(
  parts: readonly ToolPart[],
): { name: string; message: string; count: number }[] {
  const groups = new Map<string, { name: string; message: string; count: number }>();
  for (const part of parts) {
    const message = part.result?.error?.message ?? part.result?.summary ?? "";
    const key = `${part.name}\u0000${message}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { name: part.name, message, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
