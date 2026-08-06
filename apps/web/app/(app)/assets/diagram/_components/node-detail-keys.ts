/**
 * Remount keys for the node detail's General tab (issue #1228).
 *
 * The General tab renders `SecretsEditor` and `ShortcutsEditor` as two siblings inside ONE children
 * array, and each carries a data-derived `key` so that a refetch after a mutation remounts it and
 * re-seeds its local draft from the new props (that is `ShortcutsEditor`'s documented reset
 * mechanism — a remount, not an effect).
 *
 * The `scope` prefix is LOAD-BEARING, not decoration. Both keys used to be `<nodeId>:<json>`, and a
 * node with no secrets and no shortcuts stringifies BOTH to the identical `"<nodeId>:[]"`
 * (`secretRefs` is `[]` when empty; `shortcuts` is `null`, and `null ?? []` is `[]` too). React's
 * `mapRemainingChildren` indexes the old fibers by key into a Map, so the duplicate key overwrote
 * the secrets fiber with the shortcuts one — the secrets fiber then never reached `deleteChild` and
 * its DOM was never removed. Attaching the first secret to a bare node therefore left the stale,
 * empty secrets block on screen NEXT TO a freshly mounted one showing the new secret, until closing
 * the modal (a Radix portal unmount) discarded the orphan.
 *
 * Two rules keep this correct, and both are covered by the tests next to this file:
 *  - the two scopes must NEVER produce the same string, whatever the node holds;
 *  - the key must stay derived from the DATA (never a counter or a random id), or every render
 *    would remount both editors and destroy the picker query / the in-progress shortcuts draft.
 */
export function nodeSectionKey(
  scope: "secrets" | "shortcuts",
  nodeId: string,
  value: unknown,
): string {
  return `${scope}:${nodeId}:${JSON.stringify(value ?? [])}`;
}
