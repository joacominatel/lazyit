/**
 * Pure form-to-wire glue for the user create/edit forms (ADR-0058). Extracted so the mapping logic
 * — and the resolver wrapper that keeps the loose form shape flowing to `onSubmit` (issue #934) —
 * can be unit-tested without mounting a React component. Nothing here talks to the network or has any
 * React runtime; the react-hook-form import is types-only (erased at build).
 *
 * The form keeps `legajo` / `username` as plain strings (empty = "not set") and `manager` as the
 * XOR {@link ManagerFormValue} discriminated union; the entity schemas expect optional normalized
 * strings and the manager INPUT union. This drops empties and serializes the manager via
 * `toManagerInput`, so ONE source of truth (the shared `CreateUserSchema` / `UpdateUserSchema`)
 * still validates everything — including legajo/username bounds and the manager XOR — and
 * surfaces field-level errors natively.
 */

import type { FieldValues, Resolver, ResolverResult } from "react-hook-form";
import {
  type ManagerFormValue,
  toManagerInput,
  type User,
} from "@lazyit/shared";
import { directoryAttr } from "@/components/quick-view-fields";

/**
 * The form's internal value shape. `isActive` is only present (and rendered) in edit mode: a new
 * user is always created active — `CreateUserSchema` does not accept the field. `legajo` /
 * `username` are empty-string-safe (not-set = ""); `manager` is the XOR discriminator.
 */
export type UserFormValues = {
  email: string;
  firstName: string;
  lastName: string;
  legajo: string;
  username: string;
  manager: ManagerFormValue;
  jobTitle: string;
  department: string;
  isActive?: boolean;
};

export const DIRECTORY_PROFILE_FIELDS = ["jobTitle", "department"] as const;
type DirectoryProfileField = (typeof DIRECTORY_PROFILE_FIELDS)[number];
export type DirectoryProfileValues = Record<DirectoryProfileField, string>;
export type DirectoryProfileInput = Partial<Record<DirectoryProfileField, string | null>>;

// The AD/LDAP sync rewrites both on every run, so the API refuses a change (409); a spreadsheet import does not.
export function isProfileManagedByDirectory(user: Pick<User, "directorySource">): boolean {
  return user.directorySource != null;
}

export function directoryProfileValues(
  attrs: User["directoryAttrs"] | undefined,
): DirectoryProfileValues {
  return {
    jobTitle: directoryAttr(attrs, "jobTitle") ?? "",
    department: directoryAttr(attrs, "department") ?? "",
  };
}

// A create sends only what was typed.
export function newDirectoryProfile(
  values: Partial<DirectoryProfileValues>,
): Partial<DirectoryProfileValues> {
  const out: Partial<DirectoryProfileValues> = {};
  for (const key of DIRECTORY_PROFILE_FIELDS) {
    const value = (values[key] ?? "").trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

// Only what changed is sent: an untouched value never trips the directory 409 or a legacy over-long value.
export function directoryProfileInput(
  values: Partial<DirectoryProfileValues>,
  stored?: User["directoryAttrs"],
): DirectoryProfileInput {
  const before = directoryProfileValues(stored);
  const out: DirectoryProfileInput = {};
  for (const key of DIRECTORY_PROFILE_FIELDS) {
    const next = (values[key] ?? "").trim();
    if (next === before[key].trim()) continue;
    out[key] = next === "" ? null : next;
  }
  return out;
}

/**
 * Translate the form's loose values into the wire payload the resolver validates.
 *
 * - Empty `legajo` / `username` are dropped (not `""` — which fails the `min(1)` bound).
 * - `manager` is serialized via `toManagerInput`: `{ kind: 'none' }` → `null`; a linked user →
 *   `{ managerId }`; a free-text name → `{ managerName }`.
 * - `isActive` is forwarded when present (edit mode only).
 */
// An edit of a directory-synced person never carries the two keys, so an unrelated save cannot 409.
export function directoryProfilePatch(
  values: Partial<DirectoryProfileValues>,
  user: Pick<User, "directorySource" | "directoryAttrs">,
): DirectoryProfileInput {
  return isProfileManagedByDirectory(user) ? {} : directoryProfileInput(values, user.directoryAttrs);
}

export function toResolverInput(
  values: UserFormValues,
  editing?: Pick<User, "directorySource" | "directoryAttrs">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    email: values.email,
    firstName: values.firstName,
    lastName: values.lastName,
    manager: toManagerInput(values.manager),
    ...(editing ? directoryProfilePatch(values, editing) : newDirectoryProfile(values)),
  };
  // Empty optional directory fields are simply absent (not "" — which would fail min(1)).
  if (values.legajo.trim() !== "") out.legajo = values.legajo;
  if (values.username.trim() !== "") out.username = values.username;
  if (values.isActive !== undefined) out.isActive = values.isActive;
  return out;
}

/**
 * Wrap a `zodResolver` so it VALIDATES the wire shape but returns the ORIGINAL form values to
 * react-hook-form on success (issue #934).
 *
 * `zodResolver` returns its PARSED output as `values`, and RHF forwards the resolver's `values` — not
 * the raw form values — to `onSubmit`. Feeding the resolver the already-serialized wire payload
 * therefore made `onSubmit` receive the wire shape and serialize it a SECOND time (manager already
 * `null`/`{managerId}`, optionals stripped), which crashed (`toManagerInput(null)` reads `.kind` of
 * `null`) and, for edits, silently cleared the manager. Returning the original form values keeps
 * validation on the wire shape while handing `onSubmit` the loose shape it expects. Field-level
 * errors pass through untouched; a failed validation yields empty `values` per the RHF contract.
 */
export function wireShapeResolver<TValues extends FieldValues>(
  // Any `zodResolver(schema)`: its parsed-output type is the wire shape (narrower than the loose form
  // shape) and genuinely differs on `manager`. `never`-position params let this accept any such
  // resolver; the wire payload we feed it is bridged by the cast below (same escape hatch the inline
  // wrappers used) — the runtime contract (the shared schema) is what actually validates.
  base: (
    values: never,
    context: never,
    options: never,
  ) => ResolverResult | Promise<ResolverResult>,
  toWire: (values: TValues) => Record<string, unknown>,
): Resolver<TValues> {
  const validate = base as unknown as (
    values: Record<string, unknown>,
    context: unknown,
    options: unknown,
  ) => Promise<ResolverResult>;
  return async (values, context, options) => {
    const result = await validate(toWire(values), context, options);
    return Object.keys(result.errors).length
      ? { values: {}, errors: result.errors as ResolverResult<TValues>["errors"] }
      : { values, errors: {} };
  };
}
