/**
 * The closed set of domain entity keys that the shared dialogs / tables / fields / batch toasts
 * use to resolve a localized, correctly-pluralized (and, in Spanish, correctly-gendered) noun
 * INTERNALLY — instead of a caller passing a raw English word that the UI then half-translates
 * (the "¿Eliminar asset?" bug, issue #204).
 *
 * These are STABLE display keys, not API/enum values: callers pass `entityKey="asset"`, and the
 * shared component looks the noun up under the `shared` namespace (`shared.entities.*` selects in
 * `shared.dialog.*` / `shared.table.*` / `shared.field.*` / `shared.batch.*`). The keys never reach
 * the API and never gate a comparison — they only pick a translation branch, so they are safe to
 * keep as literals. Keep this list in sync with the `{entity, select, …}` branches in
 * `messages/{en,es}/shared.json`.
 */
export const ENTITY_KEYS = [
  "asset",
  "application",
  "consumable",
  "article",
  "user",
  "location",
  "model",
  "category",
  "serviceAccount",
] as const;

export type EntityKey = (typeof ENTITY_KEYS)[number];
