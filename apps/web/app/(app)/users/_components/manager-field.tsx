"use client";

import type { ManagerFormValue } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { UserCombobox } from "@/components/user-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/**
 * The manager picker (ADR-0058) — a single control that encodes the `users_manager_at_most_one` XOR in
 * the UI: a manager is EITHER a linked lazyit user, OR a free-text name, OR none. A "kind" `Select`
 * switches the mode (so the two value inputs can never both be filled at once), and the second control
 * is the user combobox or a plain text input depending on the kind. Cleared (`none`) maps to `null` on
 * the wire; the parent serializes the value with `toManagerInput`.
 *
 * Controlled by `value` / `onChange` (a {@link ManagerFormValue}), so it drops into a react-hook-form
 * `Controller` exactly like the entity `Select`s. Switching the kind RESETS the other side's value, so
 * a half-typed name never lingers behind a user pick (or vice versa).
 *
 * `excludeUserId` (the subject being edited) is hidden from the user list so a user can't pick
 * themselves as their own manager — the backend rejects `managerId === id`, this just never offers it.
 */
export function ManagerField({
  id,
  value,
  onChange,
  ariaInvalid,
  disabled,
  excludeUserId,
}: {
  id?: string;
  value: ManagerFormValue;
  onChange: (next: ManagerFormValue) => void;
  ariaInvalid?: boolean;
  disabled?: boolean;
  /** The user being edited — hidden from the manager list (no self-management). */
  excludeUserId?: string;
}) {
  const t = useTranslations("users.form.manager");

  return (
    <div className="space-y-2">
      <Select
        value={value.kind}
        disabled={disabled}
        onValueChange={(kind) => {
          if (kind === "user") onChange({ kind: "user", managerId: "" });
          else if (kind === "external")
            onChange({ kind: "external", managerName: "" });
          else onChange({ kind: "none" });
        }}
      >
        <SelectTrigger id={id} aria-invalid={ariaInvalid || undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("kind.none")}</SelectItem>
          <SelectItem value="user">{t("kind.user")}</SelectItem>
          <SelectItem value="external">{t("kind.external")}</SelectItem>
        </SelectContent>
      </Select>

      {value.kind === "user" ? (
        <UserCombobox
          value={value.managerId || undefined}
          onValueChange={(managerId) => onChange({ kind: "user", managerId })}
          ariaInvalid={ariaInvalid}
          disabled={disabled}
          excludeUserIds={excludeUserId ? [excludeUserId] : []}
          placeholder={t("userPlaceholder")}
          searchPlaceholder={t("userSearchPlaceholder")}
          emptyText={t("userEmpty")}
        />
      ) : null}

      {value.kind === "external" ? (
        <Input
          value={value.managerName}
          onChange={(e) =>
            onChange({ kind: "external", managerName: e.target.value })
          }
          aria-invalid={ariaInvalid || undefined}
          aria-label={t("externalLabel")}
          disabled={disabled}
          placeholder={t("externalPlaceholder")}
          maxLength={200}
        />
      ) : null}
    </div>
  );
}
