"use client";

import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

// UX only: mirrors the shared password schema rule-for-rule, which stays the validator (ADR-0086 §F4b).
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
