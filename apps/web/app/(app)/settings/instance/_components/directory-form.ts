/**
 * Pure form-to-wire glue for the Settings → Instance → Directory editor (issue #839, ADR-0091). Extracted
 * so the two non-trivial mappings — building the attribute map from the four recognized profile inputs, and
 * stripping the write-only bind password before sending — can be unit-tested without mounting a React
 * component. Nothing here talks to the network or has any React runtime; the `@lazyit/shared` import is
 * types-only (erased at build).
 *
 * The four recognized profile keys (firstName / lastName / email / username) each map onto a real `User`
 * column, but on the wire they are the VALUES of a `z.record(string, string)` (`{ firstName: "givenName",
 * … }`) with no per-field refinement. The editor carries them as ONE react-hook-form object field
 * (`attributeMap`) so the whole form seeds from a single `reset()` — this glue just drops blank entries when
 * assembling the wire map. Extra (non-recognized) AD attributes are out of scope for this MVP UI — the
 * backend still captures them inert under `directoryAttrs` when present in a stored map (ADR-0091).
 * ponytail: four fixed inputs, not a dynamic key/value editor.
 */

import type { UpdateDirectoryConnection } from "@lazyit/shared";

/**
 * The recognized profile→AD-attribute inputs (firstName / lastName / email / username), each an AD attribute
 * NAME (e.g. `givenName`). A plain string map (open index signature) so it seeds the react-hook-form
 * `attributeMap` object field directly.
 */
export type DirectoryAttributeInputs = Record<string, string>;

/** A blank string field → null (the "unset" value the nullish schema fields accept). Trims first. */
export function emptyToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/**
 * Assemble the wire attribute map from the four profile inputs. Each value is trimmed; blank entries are
 * DROPPED (an empty AD attribute name is not a mapping). Returns `null` when nothing is mapped so the read
 * shape distinguishes "unset" from "{}", matching the API's `attributeMap` nullability.
 */
export function buildAttributeMap(
  attrs: DirectoryAttributeInputs,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const key of ["firstName", "lastName", "email", "username"] as const) {
    const v = attrs[key].trim();
    if (v !== "") out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Translate the RHF-validated form values into the `PUT` payload.
 *
 * - The attribute map is assembled from the four `attributeMap.*` form fields via {@link buildAttributeMap}
 *   (empties dropped; `null` when none).
 * - Nullish scalar fields are normalized to `null` on the wire (the resolver hands them back as
 *   `T | null | undefined`).
 * - The bind password is stripped when blank so the stored secret is KEPT — only a non-empty value
 *   sets/rotates it (the write-only contract). It is NEVER read back, so re-saving the form must not wipe it.
 */
export function toDirectoryPayload(
  values: UpdateDirectoryConnection,
): UpdateDirectoryConnection {
  const payload: UpdateDirectoryConnection = {
    enabled: values.enabled,
    host: values.host ?? null,
    port: values.port ?? null,
    transport: values.transport,
    rejectUnauthorized: values.rejectUnauthorized,
    baseDN: values.baseDN ?? null,
    bindDN: values.bindDN ?? null,
    searchFilter: values.searchFilter ?? null,
    offboardGraceDays: values.offboardGraceDays,
    attributeMap: buildAttributeMap(attributeInputsFrom(values.attributeMap)),
  };
  if (values.bindPassword && values.bindPassword.trim() !== "") {
    payload.bindPassword = values.bindPassword;
  }
  return payload;
}

/**
 * Seed the four attribute inputs from a stored map (or defaults) — inverse of {@link buildAttributeMap}. The
 * return has the four fixed keys (all strings), so it seeds the react-hook-form `attributeMap` object field.
 */
export function attributeInputsFrom(
  map: Record<string, string | undefined> | null | undefined,
): DirectoryAttributeInputs {
  return {
    firstName: map?.firstName ?? "",
    lastName: map?.lastName ?? "",
    email: map?.email ?? "",
    username: map?.username ?? "",
  };
}
