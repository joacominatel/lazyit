"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Asset,
  type AssetStatus,
  AssetStatusSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { LocationFormDialog } from "@/app/(app)/locations/_components/location-form-dialog";
import { CreatableField } from "@/components/creatable-field";
import { CreateAssetModelDialog } from "@/components/create-asset-model-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
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
import { useAssetModels } from "@/lib/api/hooks/use-asset-models";
import { useCreateAsset, useUpdateAsset } from "@/lib/api/hooks/use-asset-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import { notifyError } from "@/lib/api/notify-error";
import { formatAssetStatus } from "./asset-status-badge";

const FORM_ID = "asset-form";
/** Radix Select forbids an empty-string item value; use a sentinel for "none". */
const NONE = "__none__";

type AssetFormValues = {
  name: string;
  status: AssetStatus;
  modelId?: string;
  locationId?: string;
  serial?: string;
  assetTag?: string;
  purchaseDate?: string; // ISO datetime
  warrantyEnd?: string; // ISO datetime
  notes?: string;
};

/** ISO datetime → "YYYY-MM-DD" for a date input (empty when absent). */
function isoToDateInput(iso?: string): string {
  return iso ? iso.slice(0, 10) : "";
}

/** "YYYY-MM-DD" from a date input → ISO datetime (undefined when empty). */
function dateInputToIso(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

function toFormValues(asset?: Asset): AssetFormValues {
  if (asset) {
    return {
      name: asset.name,
      status: asset.status,
      modelId: asset.modelId ?? undefined,
      locationId: asset.locationId ?? undefined,
      serial: asset.serial ?? undefined,
      assetTag: asset.assetTag ?? undefined,
      purchaseDate: asset.purchaseDate ?? undefined,
      warrantyEnd: asset.warrantyEnd ?? undefined,
      notes: asset.notes ?? undefined,
    };
  }
  return { name: "", status: "OPERATIONAL" };
}

/**
 * Create/edit form for an Asset. Per-mode validation (CreateAssetSchema vs the
 * partial UpdateAssetSchema — ADR-0020). `specs` is free-form jsonb: it lives in
 * local state as raw text and is parsed/validated on submit (the simple JSON
 * editor of the task; per-category schemas are deferred — ADR-0007). Dates are
 * edited as date inputs and stored as ISO datetimes (the wire shape).
 */
export function AssetForm({ asset }: { asset?: Asset }) {
  const isEdit = asset != null;
  const router = useRouter();
  const { data: models } = useAssetModels();
  const { data: locations } = useLocations();
  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const isPending = createAsset.isPending || updateAsset.isPending;

  const [specsText, setSpecsText] = useState(
    asset?.specs ? JSON.stringify(asset.specs, null, 2) : "",
  );
  const [specsError, setSpecsError] = useState<string | null>(null);

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateAssetSchema : CreateAssetSchema,
    ) as Resolver<AssetFormValues>,
    defaultValues: toFormValues(asset),
  });

  const onSubmit = form.handleSubmit((values) => {
    // Parse the free-form specs JSON; an object or nothing, never invalid.
    let specs: Record<string, unknown> | undefined;
    const trimmed = specsText.trim();
    if (trimmed) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        setSpecsError("Invalid JSON.");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setSpecsError('Specs must be a JSON object, e.g. {"ram":"16GB"}.');
        return;
      }
      specs = parsed as Record<string, unknown>;
    }
    setSpecsError(null);

    const payload = {
      name: values.name,
      status: values.status,
      serial: values.serial,
      assetTag: values.assetTag,
      modelId: values.modelId,
      locationId: values.locationId,
      purchaseDate: values.purchaseDate,
      warrantyEnd: values.warrantyEnd,
      notes: values.notes,
      specs,
    };

    if (asset) {
      updateAsset.mutate(
        { id: asset.id, data: payload },
        {
          onSuccess: (updated) => {
            toast.success("Asset saved");
            router.push(`/assets/${updated.id}`);
          },
          onError: (error) =>
            notifyError(error, "Couldn't save the asset"),
        },
      );
    } else {
      createAsset.mutate(payload, {
        onSuccess: (created) => {
          toast.success("Asset created");
          router.push(`/assets/${created.id}`);
        },
        onError: (error) =>
          notifyError(error, "Couldn't create the asset"),
      });
    }
  });

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                {...field}
                id="name"
                value={field.value ?? ""}
                placeholder="Ada's laptop"
                aria-invalid={fieldState.invalid || undefined}
                autoFocus
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="status"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="status">Status</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AssetStatusSchema.options.map((status) => (
                      <SelectItem key={status} value={status}>
                        {formatAssetStatus(status)}
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
            name="modelId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="modelId">Model</FieldLabel>
                <CreatableField
                  label="model"
                  renderDialog={(dialog) => (
                    <CreateAssetModelDialog
                      open={dialog.open}
                      onOpenChange={dialog.onOpenChange}
                      onCreated={(model) => field.onChange(model.id)}
                    />
                  )}
                >
                  <Select
                    value={field.value ?? NONE}
                    onValueChange={(value) =>
                      field.onChange(value === NONE ? undefined : value)
                    }
                  >
                    <SelectTrigger id="modelId" className="w-full">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {(models ?? []).map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.manufacturer} {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="locationId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="locationId">Location</FieldLabel>
                <CreatableField
                  label="location"
                  renderDialog={(dialog) => (
                    <LocationFormDialog
                      open={dialog.open}
                      onOpenChange={dialog.onOpenChange}
                      onCreated={(location) => field.onChange(location.id)}
                    />
                  )}
                >
                  <Select
                    value={field.value ?? NONE}
                    onValueChange={(value) =>
                      field.onChange(value === NONE ? undefined : value)
                    }
                  >
                    <SelectTrigger id="locationId" className="w-full">
                      <SelectValue placeholder="Select a location" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {(locations ?? []).map((location) => (
                        <SelectItem key={location.id} value={location.id}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="serial"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="serial">Serial</FieldLabel>
                <Input
                  id="serial"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder="SN-12345"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="assetTag"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="assetTag">Asset tag</FieldLabel>
                <Input
                  id="assetTag"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder="LZ-0001"
                  className="font-mono"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="purchaseDate"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="purchaseDate">Purchase date</FieldLabel>
                <Input
                  id="purchaseDate"
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  value={isoToDateInput(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(dateInputToIso(event.target.value))
                  }
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="warrantyEnd"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="warrantyEnd">Warranty end</FieldLabel>
                <Input
                  id="warrantyEnd"
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  value={isoToDateInput(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(dateInputToIso(event.target.value))
                  }
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>

        <Controller
          control={form.control}
          name="notes"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="notes">Notes</FieldLabel>
              <Textarea
                id="notes"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                rows={2}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <Field data-invalid={specsError ? true : undefined}>
          <FieldLabel htmlFor="specs">Specs (JSON)</FieldLabel>
          <Textarea
            id="specs"
            value={specsText}
            onChange={(event) => {
              setSpecsText(event.target.value);
              if (specsError) setSpecsError(null);
            }}
            placeholder={'{\n  "cpu": "Apple M3",\n  "ram": "16GB"\n}'}
            className="min-h-[140px] font-mono text-sm"
            aria-invalid={specsError ? true : undefined}
          />
          <FieldDescription>
            Free-form JSON object; validated on save. Per-category schemas are a
            future improvement (ADR-0007).
          </FieldDescription>
          {specsError && (
            <p role="alert" className="text-sm text-destructive">
              {specsError}
            </p>
          )}
        </Field>
      </FieldGroup>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => router.push(asset ? `/assets/${asset.id}` : "/assets")}
        >
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : "Create asset"}
        </Button>
      </div>
    </form>
  );
}
