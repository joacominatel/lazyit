"use client";

import { useLocale, useTranslations } from "next-intl";
import { type ComponentProps, useId, useState } from "react";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatMoney, type MoneyParseError, parseMoneyInput } from "@/lib/utils/money";

/** The example amount shown in the messages, in the viewer's locale ("1,234.56" / "1.234,56"). */
const EXAMPLE_MINOR = 123456;

/** The localized inline message for a refused amount. */
export function useMoneyErrorMessage(): (error: MoneyParseError) => string {
  const t = useTranslations("common.money");
  const locale = useLocale();
  const example = formatMoney(EXAMPLE_MINOR, locale);
  return (error) => t(error, { example });
}

/** Stored minor units → the text a money input starts with (blank when not set). */
export function moneyInputText(minor: number | null | undefined, locale: string): string {
  return minor == null ? "" : formatMoney(minor, locale);
}

export interface MoneyInputProps
  extends Omit<ComponentProps<"input">, "value" | "onChange" | "defaultValue" | "type"> {
  /** The raw text, as typed. Parse it on submit with `parseMoneyInput(text, locale)`. */
  value: string;
  onValueChange: (text: string) => void;
}

/**
 * A money amount typed in the viewer's locale (#1470): `1.234,56` or `1234,56` in es, `1,234.56` or
 * `1234.56` in en, at most two decimals, never negative. The form keeps the text and converts it once
 * on submit with `parseMoneyInput` (`lib/utils/money.ts`), refusing the submit while it is invalid.
 *
 * The check runs when the field is left (or on Enter), never mid-typing: a refused amount shows its
 * inline reason and marks the input `aria-invalid` (so `scrollToFirstError` finds it); an accepted one
 * is rewritten in the display format ("1234,5" → "1.234,50"), confirming how it was read. Use it
 * inside a `Field` with a `FieldLabel htmlFor={id}`, like any input.
 */
export function MoneyInput({
  value,
  onValueChange,
  onBlur,
  onKeyDown,
  "aria-describedby": describedBy,
  ...inputProps
}: MoneyInputProps) {
  const locale = useLocale();
  const errorMessage = useMoneyErrorMessage();
  const [checked, setChecked] = useState(false);
  const errorId = useId();

  const result = parseMoneyInput(value, locale);
  const error = checked && !result.ok ? errorMessage(result.error) : null;

  function check() {
    setChecked(true);
    if (result.ok) onValueChange(moneyInputText(result.minor, locale));
  }

  return (
    <>
      <Input
        {...inputProps}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined}
        aria-errormessage={error ? errorId : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          setChecked(false);
        }}
        onBlur={(event) => {
          check();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") check();
          onKeyDown?.(event);
        }}
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </>
  );
}
