"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";

/**
 * The access-level vocabulary lazyit suggests. AccessGrant.accessLevel is intentionally **free-form**
 * (each application owns its role names — ADR-0023 / the shared schema), so this is a *suggestion*
 * list, not an enum: the combobox lets you pick a common value or type your own. Frontend-only on
 * purpose — promoting it to `@lazyit/shared` would imply the backend validates against it, which it
 * deliberately does not.
 */
export const COMMON_ACCESS_LEVELS = [
  "admin",
  "developer",
  "editor",
  "member",
  "viewer",
  "billing",
  "owner",
] as const;

interface AccessLevelComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A combobox for a grant's access level: a text input wired to a native `<datalist>` of the common
 * values ({@link COMMON_ACCESS_LEVELS}). It keeps the field free-form (you can type anything the
 * app uses) while surfacing the usual choices — the consistent control the grant create/edit dialogs
 * share, instead of a bare free-text input. No Popover/Command dependency, so it works inside the
 * dialogs without portal/focus juggling.
 */
export function AccessLevelCombobox({
  id,
  value,
  onChange,
  placeholder = "admin, developer, viewer…",
  disabled,
}: AccessLevelComboboxProps) {
  const generatedId = useId();
  const listId = `access-levels-${generatedId}`;
  return (
    <>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        list={listId}
        disabled={disabled}
        autoComplete="off"
      />
      <datalist id={listId}>
        {COMMON_ACCESS_LEVELS.map((level) => (
          <option key={level} value={level} />
        ))}
      </datalist>
    </>
  );
}
