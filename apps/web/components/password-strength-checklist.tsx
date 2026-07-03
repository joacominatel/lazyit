"use client";

import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * Live password-complexity checklist for the local-mode password lifecycle (ADR-0086 §F4b). The rule
 * predicates mirror the shared `ZitadelPasswordSchema` (min 8, max 70, upper/lower/number/symbol)
 * rule-for-rule — the SAME policy `/setup` and admin temp-passwords enforce, so there is no drift —
 * plus a form-local confirm-match row. Labels come from `auth.password.checklist.*` (en + es).
 *
 * A view-only mirror of the setup wizard's checklist (kept local there to avoid refactoring shipped
 * code); the schema stays the single source of truth for validation — this is purely a UX affordance.
 */
export function PasswordStrengthChecklist({
  password,
  confirmPassword,
}: {
  password: string;
  confirmPassword: string;
}) {
  const t = useTranslations("auth.password.checklist");
  const items: { label: string; passed: boolean }[] = [
    { label: t("minLength"), passed: password.length >= 8 },
    { label: t("maxLength"), passed: password.length > 0 && password.length <= 70 },
    { label: t("uppercase"), passed: /[A-Z]/.test(password) },
    { label: t("lowercase"), passed: /[a-z]/.test(password) },
    { label: t("number"), passed: /[0-9]/.test(password) },
    { label: t("symbol"), passed: /[^A-Za-z0-9]/.test(password) },
    {
      label: t("match"),
      passed: password.length > 0 && password === confirmPassword,
    },
  ];

  return (
    <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item.label}
          className={cn(
            "flex items-center gap-2 text-xs",
            item.passed ? "text-success" : "text-muted-foreground",
          )}
        >
          {item.passed ? (
            <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <XMarkIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
