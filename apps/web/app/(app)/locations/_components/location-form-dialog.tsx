"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type CreateLocation,
  CreateLocationSchema,
  type Location,
  LocationTypeSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import {
  useCreateLocation,
  useUpdateLocation,
} from "@/lib/api/hooks/use-location-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import { notifyError } from "@/lib/api/notify-error";
import { useLocationTypeLabel } from "./location-type-badge";

const FORM_ID = "location-form";

/**
 * Radix `Select` can't use `""`/`null` as an item value, so a sentinel stands in for "no parent"
 * (root). It maps to `parentId: null` on submit — the API reads `null` as "promote to root" (#845).
 */
const ROOT_VALUE = "__root__";

/**
 * Maps a Location (or nothing, for create) to form values. Optional DB fields
 * are `null`; the form works in `undefined` (an empty optional) so the strict
 * `CreateLocationSchema` accepts an untouched field instead of an empty string.
 * `parentId` (`null` = a root location) is part of the shared schema (#845).
 */
function toFormValues(location?: Location): CreateLocation {
  return {
    name: location?.name ?? "",
    type: location?.type ?? "OFFICE",
    description: location?.description ?? undefined,
    address: location?.address ?? undefined,
    floor: location?.floor ?? undefined,
    notes: location?.notes ?? undefined,
    parentId: location?.parentId ?? null,
  };
}

interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that location; absent → create a new one. */
  location?: Location;
  /** Called with the created location (create mode) — lets a caller select it inline (#25). */
  onCreated?: (location: Location) => void;
}

/**
 * Create/edit dialog for a Location. One form, two modes: it always validates
 * against `CreateLocationSchema` (name + type required) and either POSTs a new
 * record or PATCHes the existing one.
 */
export function LocationFormDialog({
  open,
  onOpenChange,
  location,
  onCreated,
}: LocationFormDialogProps) {
  const t = useTranslations("locations");
  const tc = useTranslations("common");
  const locationTypeLabel = useLocationTypeLabel();
  const isEdit = location != null;
  const createLocation = useCreateLocation();
  const updateLocation = useUpdateLocation();
  const isPending = createLocation.isPending || updateLocation.isPending;

  // Parent options: the whole (active) location directory, minus invalid choices. The server is the
  // source of truth (it 400s a cycle), so we only trim the cheap cases client-side (#845): a location
  // can't be its own parent, nor sit under its own direct children. Deeper cycles fall to the 400.
  const { data: allLocations } = useLocations();
  const parentOptions = useMemo(() => {
    const rows = allLocations ?? [];
    if (!location) return rows;
    return rows.filter(
      (row) => row.id !== location.id && row.parentId !== location.id,
    );
  }, [allLocations, location]);

  const form = useForm<CreateLocation>({
    resolver: zodResolver(CreateLocationSchema),
    defaultValues: toFormValues(location),
  });

  // Refresh the form whenever it opens (or the target location changes), so a
  // reused dialog never shows stale values from a previous create/edit.
  useEffect(() => {
    if (open) form.reset(toFormValues(location));
  }, [open, location, form]);

  // A parent that's a cycle (self/descendant) or missing/soft-deleted comes back as a 400 (#845).
  // Surface it inline on the parent field rather than as a bare toast; anything else keeps the toast.
  function handleWriteError(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.status === 400) {
      form.setError("parentId", { type: "server", message: error.message });
      return;
    }
    notifyError(error, fallback);
  }

  const onSubmit = form.handleSubmit((values) => {
    // `parentId` is part of the payload (#845); `null` promotes to a root.
    if (location) {
      updateLocation.mutate(
        { id: location.id, data: values },
        {
          onSuccess: () => {
            toast.success(t("form.toast.updated"));
            onOpenChange(false);
          },
          onError: (error) => handleWriteError(error, t("form.toast.updateError")),
        },
      );
    } else {
      createLocation.mutate(values, {
        onSuccess: (created) => {
          onCreated?.(created);
          toast.success(t("form.toast.created"));
          onOpenChange(false);
        },
        onError: (error) => handleWriteError(error, t("form.toast.createError")),
      });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("form.editTitle") : t("form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("form.editDescription")
              : t("form.createDescription")}
          </DialogDescription>
        </DialogHeader>

        {/* stopPropagation: this dialog renders in a Radix Portal, but React events bubble through
            the React tree (not the DOM), so when opened inline from another form (e.g. the asset
            form's "+ New location") the inner submit would otherwise reach the parent form's
            onSubmit and submit it too (issue #164). */}
        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="name">{t("form.fields.name")}</FieldLabel>
                  <Input
                    {...field}
                    id="name"
                    value={field.value ?? ""}
                    placeholder={t("form.placeholders.name")}
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  {/* `name` is `min(1).max(200)`; only the empty case is common — swap in the
                      localized copy for the required case rather than leak the raw zod message
                      (issue #966, same class as the KB article `title` fix). */}
                  <FieldError
                    errors={[
                      fieldState.error?.type === "too_small"
                        ? { message: t("form.fields.nameRequired") }
                        : fieldState.error,
                    ]}
                  />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="type"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="type">{t("form.fields.type")}</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="type"
                      className="w-full"
                      aria-invalid={fieldState.invalid || undefined}
                    >
                      <SelectValue placeholder={t("form.placeholders.type")} />
                    </SelectTrigger>
                    <SelectContent>
                      {LocationTypeSchema.options.map((value) => (
                        <SelectItem key={value} value={value}>
                          {locationTypeLabel(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="parentId"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="parentId">
                    {t("form.fields.parent")}
                  </FieldLabel>
                  <Select
                    value={field.value ?? ROOT_VALUE}
                    onValueChange={(value) => {
                      field.onChange(value === ROOT_VALUE ? null : value);
                      // Clear a stale server 400 once the user picks a different parent.
                      if (fieldState.error) form.clearErrors("parentId");
                    }}
                  >
                    <SelectTrigger
                      id="parentId"
                      className="w-full"
                      aria-invalid={fieldState.invalid || undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ROOT_VALUE}>
                        {t("form.parentNone")}
                      </SelectItem>
                      {parentOptions.map((parent) => (
                        <SelectItem key={parent.id} value={parent.id}>
                          {parent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldState.error ? (
                    <FieldError errors={[fieldState.error]} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("form.parentHint")}
                    </p>
                  )}
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="address"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="address">{t("form.fields.address")}</FieldLabel>
                  <Input
                    id="address"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(e) =>
                      field.onChange(e.target.value || undefined)
                    }
                    placeholder={t("form.placeholders.address")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="floor"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="floor">{t("form.fields.floor")}</FieldLabel>
                  <Input
                    id="floor"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(e) =>
                      field.onChange(e.target.value || undefined)
                    }
                    placeholder={t("form.placeholders.floor")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="description"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="description">{t("form.fields.description")}</FieldLabel>
                  <Textarea
                    id="description"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(e) =>
                      field.onChange(e.target.value || undefined)
                    }
                    rows={2}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="notes">{t("form.fields.notes")}</FieldLabel>
                  <Textarea
                    id="notes"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(e) =>
                      field.onChange(e.target.value || undefined)
                    }
                    rows={2}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={isPending}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {isEdit ? t("form.editSubmit") : t("form.createSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
