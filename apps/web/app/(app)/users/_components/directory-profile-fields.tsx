"use client";

import { useTranslations } from "next-intl";
import { type Control, Controller, type FieldValues, type Path } from "react-hook-form";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  DIRECTORY_PROFILE_FIELDS,
  type DirectoryProfileValues,
} from "./user-form-payload";

/** Department and job title (#1646), read-only for a person the AD/LDAP sync owns. */
export function DirectoryProfileFields<T extends FieldValues & DirectoryProfileValues>({
  control,
  idPrefix,
  managedByDirectory,
}: {
  control: Control<T>;
  idPrefix: string;
  managedByDirectory: boolean;
}) {
  const t = useTranslations("users.form");
  return (
    <>
      {DIRECTORY_PROFILE_FIELDS.map((name) => (
        <Controller
          key={name}
          control={control}
          name={name as Path<T>}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor={`${idPrefix}-${name}`}>{t(name)}</FieldLabel>
              <Input
                {...field}
                id={`${idPrefix}-${name}`}
                value={field.value ?? ""}
                placeholder={t(`${name}Placeholder`)}
                disabled={managedByDirectory}
                aria-invalid={fieldState.invalid || undefined}
              />
              {managedByDirectory && (
                <FieldDescription>{t("directoryManagedHint")}</FieldDescription>
              )}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      ))}
    </>
  );
}
