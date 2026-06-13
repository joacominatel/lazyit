/**
 * Pure form-to-wire glue for UserFormDialog (ADR-0058). Extracted so the mapping logic can be
 * unit-tested without mounting the React component. Nothing here talks to the network or React —
 * deterministic mappers over plain values only.
 *
 * The form keeps `legajo` / `username` as plain strings (empty = "not set") and `manager` as the
 * XOR {@link ManagerFormValue} discriminated union; the entity schemas expect optional normalized
 * strings and the manager INPUT union. This drops empties and serializes the manager via
 * `toManagerInput`, so ONE source of truth (the shared `CreateUserSchema` / `UpdateUserSchema`)
 * still validates everything — including legajo/username bounds and the manager XOR — and
 * surfaces field-level errors natively.
 */

import {
  type ManagerFormValue,
  toManagerInput,
} from "@lazyit/shared";

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
  isActive?: boolean;
};

/**
 * Translate the form's loose values into the wire payload the resolver validates.
 *
 * - Empty `legajo` / `username` are dropped (not `""` — which fails the `min(1)` bound).
 * - `manager` is serialized via `toManagerInput`: `{ kind: 'none' }` → `null`; a linked user →
 *   `{ managerId }`; a free-text name → `{ managerName }`.
 * - `isActive` is forwarded when present (edit mode only).
 */
export function toResolverInput(values: UserFormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    email: values.email,
    firstName: values.firstName,
    lastName: values.lastName,
    manager: toManagerInput(values.manager),
  };
  // Empty optional directory fields are simply absent (not "" — which would fail min(1)).
  if (values.legajo.trim() !== "") out.legajo = values.legajo;
  if (values.username.trim() !== "") out.username = values.username;
  if (values.isActive !== undefined) out.isActive = values.isActive;
  return out;
}
