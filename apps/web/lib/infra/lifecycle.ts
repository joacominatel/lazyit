import { INFRA_NODE_SNOOZE_MAX_DAYS, isAlertsSnoozed } from "@lazyit/shared";

/**
 * The retire + snooze lifecycle of a node, as every surface that badges it reads it (#1701).
 *
 * The map card, the review tray, the Servers table, the node drill-in and the fleet view all show the
 * same two badges, and they must agree on what counts. So the rule lives here, once, on top of the
 * shared `isAlertsSnoozed` the API sweeper itself uses: only a snooze strictly in the FUTURE counts,
 * and an absent field (an API older than #1701) reads as active and not snoozed.
 */
export interface NodeLifecycle {
  retired: boolean;
  /** The ISO instant the snooze ends, or `null` when the node is not snoozed right now. */
  snoozedUntil: string | null;
}

export function nodeLifecycle(
  node: { retiredAt?: string | null; alertsSnoozedUntil?: string | null },
  now: number = Date.now(),
): NodeLifecycle {
  const until = node.alertsSnoozedUntil ?? null;
  return {
    retired: Boolean(node.retiredAt),
    snoozedUntil: until !== null && isAlertsSnoozed(until, now) ? until : null,
  };
}

/**
 * The snooze lengths the menu offers. A maintenance window, so short and few: an evening, a day, a
 * long weekend, a week, a month. Every one sits inside the API's ceiling (the test pins it), and a
 * host that should never alert again is RETIRED instead.
 */
export const SNOOZE_PRESETS = ["4h", "1d", "3d", "7d", "30d"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

const HOUR_MS = 60 * 60 * 1000;
const PRESET_MS: Record<SnoozePreset, number> = {
  "4h": 4 * HOUR_MS,
  "1d": 24 * HOUR_MS,
  "3d": 3 * 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};

/** The longest snooze the API accepts, in ms (`INFRA_NODE_SNOOZE_MAX_DAYS`). */
export const SNOOZE_MAX_MS = INFRA_NODE_SNOOZE_MAX_DAYS * 24 * HOUR_MS;

/** The `until` to send for a preset, as the ISO instant `PUT /infra/nodes/:id/snooze` takes. */
export function snoozeUntilFor(preset: SnoozePreset, now: number = Date.now()): string {
  return new Date(now + Math.min(PRESET_MS[preset], SNOOZE_MAX_MS)).toISOString();
}
