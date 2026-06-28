/**
 * UI metadata for the structural secret kind (ADR-0075) — the icon + ordered list shared by the vault-
 * list badge, the create/edit kind selector, and the typed reveal. Labels themselves are i18n
 * (`secrets.kinds.*`); this only maps `kind` → its heroicon and pins the selector order. Pure (icon
 * VALUES only, no JSX), so it can be imported by both Client Components and plain modules.
 */

import {
  ClockIcon,
  CommandLineIcon,
  DocumentCheckIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import { createElement, type ComponentProps } from "react";
import type { SecretItemKind } from "@lazyit/shared";

/** The kinds in the order they appear in the selector (GENERIC first = the default/common path). */
export const SECRET_KINDS: SecretItemKind[] = [
  "GENERIC",
  "SSH_KEY",
  "TOTP",
  "CERTIFICATE",
];

/** Map a `kind` to its heroicon (outline, 24). GENERIC keeps the existing key glyph. */
export function secretKindIcon(kind: SecretItemKind): typeof KeyIcon {
  switch (kind) {
    case "SSH_KEY":
      return CommandLineIcon;
    case "TOTP":
      return ClockIcon;
    case "CERTIFICATE":
      return DocumentCheckIcon;
    case "GENERIC":
    default:
      return KeyIcon;
  }
}

/**
 * A module-scope component that renders the `kind`'s glyph. Defined here (not inline in a render body)
 * so it is a STABLE component — selecting the icon at render time inside a parent would trip the
 * "component created during render" lint and reset state. Uses `createElement` so this stays a `.ts`.
 */
export function SecretKindIcon({
  kind,
  ...props
}: { kind: SecretItemKind } & ComponentProps<typeof KeyIcon>) {
  return createElement(secretKindIcon(kind), props);
}
