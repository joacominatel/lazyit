import type { NotificationType } from "@lazyit/shared";

/**
 * The opted-out set to PUT after one switch flips (#879), never carrying a security notice (#1699):
 * those are always emailed, so their switch is fixed on and a legacy opt-out entry for one is dropped
 * from the next save. ON = receive email = NOT opted out; OFF adds the type to the set.
 */
export function nextOptedOutTypes(
  current: readonly NotificationType[],
  type: NotificationType,
  emailOn: boolean,
  mandatory: ReadonlySet<NotificationType>,
): NotificationType[] {
  const kept = current.filter((t) => !mandatory.has(t));
  if (mandatory.has(type)) return kept;
  if (emailOn) return kept.filter((t) => t !== type);
  return kept.includes(type) ? kept : [...kept, type];
}

/** Whether a type's email switch reads ON: always for a security notice, else when not opted out. */
export function isEmailOn(
  optedOut: readonly NotificationType[],
  type: NotificationType,
  mandatory: ReadonlySet<NotificationType>,
): boolean {
  return mandatory.has(type) || !optedOut.includes(type);
}
