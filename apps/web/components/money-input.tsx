"use client";

import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  ambiguousReading,
  formatMoney,
  type MoneyParseError,
  parseMoneyInput,
} from "@/lib/utils/money";

/** The example amount shown in the messages, in the viewer's locale ("1,234.56" / "1.234,56"). */
const EXAMPLE_MINOR = 123456;

/** The localized inline message for a refused amount. */
function useMoneyErrorMessage(): (error: MoneyParseError) => string {
  const t = useTranslations("common.money");
  const locale = useLocale();
  const example = formatMoney(EXAMPLE_MINOR, locale);
  return (error) => t(error, { example });
}

/** Stored minor units → the text a money field starts with (blank when not set). */
export function moneyInputText(minor: number | null | undefined, locale: string): string {
  return minor == null ? "" : formatMoney(minor, locale);
}

export interface MoneyFieldProps {
  id: string;
  label: ReactNode;
  /** Help text under the input. */
  description?: ReactNode;
  /** The raw text, as typed. Parse it on submit with `parseMoneyInput(text, locale)`. */
  value: string;
  onValueChange: (text: string) => void;
  placeholder?: string;
}

/**
 * A money amount typed in the viewer's locale (#1470), as a whole `Field` (label, input, help, error):
 * `1.234,56` or `1234,56` in es, `1,234.56` or `1234.56` in en, at most two decimals, never negative.
 * The form keeps the text and converts it once on submit with `parseMoneyInput`
 * (`lib/utils/money.ts`), refusing the submit while it is invalid.
 *
 * The check runs when the field is left (or on Enter), never mid-typing — and from the start for a
 * prefilled value, so one that no longer reads in the current locale shows why and a save is never a
 * silent no-op. A refused amount marks the `Field` and its input invalid (so `scrollToFirstError`
 * finds it) with its reason; an accepted one is rewritten in the display format ("1234,5" →
 * "1.234,50"). When the entry has the one shape both locales read differently (`1.150` in es,
 * `1,150` in en), the field echoes how it was read: "Read as 1150".
 */
export function MoneyField({
  id,
  label,
  description,
  value,
  onValueChange,
  placeholder,
}: MoneyFieldProps) {
  const locale = useLocale();
  const t = useTranslations("common.money");
  const errorMessage = useMoneyErrorMessage();
  // A prefilled value is checked from the start; a typed one once the field is left.
  const [checked, setChecked] = useState(() => value.trim() !== "");
  // The "Read as" echo answers what the operator TYPED (not the reformatted text, which is always
  // grouped), so it is captured when they leave the field and cleared when they type again.
  const [reading, setReading] = useState<string | null>(null);

  const result = parseMoneyInput(value, locale);
  const error = checked && !result.ok ? errorMessage(result.error) : null;
  const readingId = `${id}-reading`;

  function check() {
    setChecked(true);
    setReading(result.ok ? ambiguousReading(value, locale) : null);
    if (result.ok) onValueChange(moneyInputText(result.minor, locale));
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={reading ? readingId : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          setChecked(false);
          setReading(null);
        }}
        onBlur={check}
        onKeyDown={(event) => {
          if (event.key === "Enter") check();
        }}
      />
      {reading ? (
        <p id={readingId} role="status" className="text-sm text-muted-foreground">
          {t("readAs", { amount: reading })}
        </p>
      ) : null}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
