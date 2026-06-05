import type {
  CapabilityId,
  Permission,
  PermissionPillar,
  PresetId,
} from "@lazyit/shared";

/**
 * Locale-aware lookup of the permission/pillar/capability/preset DISPLAY labels (issue #215).
 *
 * `@lazyit/shared` stays a framework-agnostic leaf: it keeps the permission/pillar/capability/preset
 * KEYS and the `PERMISSION_META` / `PILLAR_META` / `CAPABILITIES` / `PERMISSION_PRESETS` data (the
 * stable ids consumed by logic and guarded by the covering-set test), but the English `label` /
 * `description` strings it carries no longer reach the UI directly — they would stay English under an
 * `es` locale. Instead the localized copy lives in the web catalog (`messages/{en,es}/settings.json`
 * under `permissionMeta.*`), keyed by the SAME ids, and is resolved here at the render sites.
 *
 * The ids stay intact for logic; only the human-facing label/description are translated (ADR-0051 —
 * never translate the data id itself). These helpers take the `settings`-scoped translator (from
 * `useTranslations("settings")`) so every settings component resolves labels the same way.
 */

/** A `settings`-scoped translator (matches next-intl's `useTranslations("settings")`). */
export type SettingsTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * next-intl uses `.` as its message-path separator, so an id that contains a `.` (capability ids like
 * `inventory.view`) can't be a key segment. The catalog stores those ids with `.` swapped for `:`
 * (matching the `domain:action` style already used for permission ids); this mirrors that swap when
 * building the lookup key. Permission/pillar/preset ids have no `.`, so the swap is a no-op for them.
 */
function toKeySegment(id: string): string {
  return id.replaceAll(".", ":");
}

/** Localized label for a single catalog permission (`domain:action`). */
export function permissionLabel(t: SettingsTranslator, permission: Permission): string {
  return t(`permissionMeta.permissions.${permission}.label`);
}

/** Localized label for a product pillar (Inventory / Access / Knowledge / Manage). */
export function pillarLabel(t: SettingsTranslator, pillar: PermissionPillar): string {
  return t(`permissionMeta.pillars.${pillar}.label`);
}

/** Localized one-line description for a product pillar. */
export function pillarDescription(
  t: SettingsTranslator,
  pillar: PermissionPillar,
): string {
  return t(`permissionMeta.pillars.${pillar}.description`);
}

/** Localized label for a capability toggle. */
export function capabilityLabel(t: SettingsTranslator, id: CapabilityId): string {
  return t(`permissionMeta.capabilities.${toKeySegment(id)}.label`);
}

/** Localized one-line description for a capability toggle. */
export function capabilityDescription(
  t: SettingsTranslator,
  id: CapabilityId,
): string {
  return t(`permissionMeta.capabilities.${toKeySegment(id)}.description`);
}

/** Localized label for a named preset. */
export function presetLabel(t: SettingsTranslator, id: PresetId): string {
  return t(`permissionMeta.presets.${toKeySegment(id)}.label`);
}

/** Localized one-line description for a named preset. */
export function presetDescription(t: SettingsTranslator, id: PresetId): string {
  return t(`permissionMeta.presets.${toKeySegment(id)}.description`);
}
