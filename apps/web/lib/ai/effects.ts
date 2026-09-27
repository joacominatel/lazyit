import type { AiRunEvent } from "@lazyit/shared";
import { entityHref } from "./entity-href";

/**
 * Tool result → what the page around the chat does (frontend.md Fork C3 and D3; tools-and-execution.md
 * §8.5). Pure: the hook applies the plan.
 *
 *   - after ANY executed mutation, every active query outside the assistant's own `["ai", …]` subtree is
 *     invalidated — a created asset appears in the open list, a derived read (the dashboard) cannot be
 *     missed, and no per-resource map can drift from the mutation hooks (the #499 bug class);
 *   - a `navigate`-kind call moves the user to its target only when it arrived LIVE (never from a
 *     snapshot or a replay after a reload) and no screen holds unsaved edits; otherwise its "Open" chip
 *     is the way there.
 */

export interface EffectPlan {
  /** Invalidate every active query except the assistant's own. */
  invalidate: boolean;
  /** Navigate to this internal href now. */
  navigateTo: string | null;
}

export const NO_EFFECT: EffectPlan = { invalidate: false, navigateTo: null };

export interface EffectContext {
  /** The event arrived on the live stream (not a snapshot). */
  live: boolean;
  /** A screen holds unsaved edits (`hasUnsavedChanges()`). */
  unsaved: boolean;
  /** This call's effects were already applied (a reconnect replays). */
  alreadyApplied: boolean;
}

export function planEffects(event: AiRunEvent, ctx: EffectContext): EffectPlan {
  if (event.type !== "tool.result" || event.status !== "ok" || ctx.alreadyApplied) return NO_EFFECT;

  const invalidate = event.mutated === true;

  let navigateTo: string | null = null;
  if (event.kind === "navigate" && ctx.live && !ctx.unsaved) {
    const target = event.entityRefs.find((ref) => ref.op === "navigate") ?? event.entityRefs[0];
    navigateTo = target ? entityHref(target) : null;
  }
  return { invalidate, navigateTo };
}

/**
 * A `run.snapshot` (a reconnect the replay buffer could not cover) may carry mutations the stream never
 * delivered live. It never navigates; it invalidates once when it holds an executed mutation whose
 * effects were not applied yet, and names the calls it covered so they are not applied twice.
 */
export function planSnapshotEffects(
  event: AiRunEvent,
  applied: ReadonlySet<string>,
): { invalidate: boolean; callIds: string[] } {
  if (event.type !== "run.snapshot") return { invalidate: false, callIds: [] };
  const callIds: string[] = [];
  for (const message of event.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.result) continue;
      if (part.result.status === "ok" && part.result.mutated && !applied.has(part.toolCallId)) {
        callIds.push(part.toolCallId);
      }
    }
  }
  return { invalidate: callIds.length > 0, callIds };
}

/** The query-invalidation predicate: every query outside the `["ai", …]` subtree. */
export function isOutsideAssistant(query: { queryKey: readonly unknown[] }): boolean {
  return query.queryKey[0] !== "ai";
}
