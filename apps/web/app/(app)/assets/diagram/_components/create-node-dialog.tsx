"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { InfraNodeKindSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { AssetCombobox } from "@/components/asset-combobox";
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
import { Switch } from "@/components/ui/switch";
import { useCreateInfraNode } from "@/lib/api/hooks/use-infra-nodes";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

/**
 * Create-node flow (ADR-0070 §5). The minimal form the canvas needs: a `label`, a `kind`, and the
 * DEFAULT-ON "track as asset" toggle. With the toggle on the operator may optionally link an existing
 * Asset; left empty, the API mints a minimal backing Asset (name = label) so the node immediately has
 * an owner/KB/secret surface. Toggle off → a graph-only node (right for ephemeral containers); the
 * asset picker is hidden and `trackAsAsset:false` is sent (no `assetId`, which the API would reject as
 * a contradiction). Full asset fields live on the Assets screen — this is just enough to back the node.
 *
 * ponytail: no zod resolver — the shared `CreateInfraNodeSchema` is a `strictObject`, so validating a
 * superset form (with our local `trackAsAsset`/`assetId` UI fields) would reject the extra keys; RHF's
 * field-level `required` is enough here and the API stays the authority (matches the grant dialog).
 */
type FormValues = {
  label: string;
  kind: string;
  trackAsAsset: boolean;
  assetId: string;
};

const FORM_ID = "create-infra-node-form";

const KIND_OPTIONS = InfraNodeKindSchema.options;

interface CreateNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateNodeDialog({ open, onOpenChange }: CreateNodeDialogProps) {
  const t = useTranslations("infra");
  const tc = useTranslations("common");
  const create = useCreateInfraNode();

  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: { label: "", kind: "", trackAsAsset: true, assetId: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values/errors.
  useEffect(() => {
    if (open) {
      form.reset({ label: "", kind: "", trackAsAsset: true, assetId: "" });
    }
  }, [open, form]);

  const trackAsAsset = useWatch({ control: form.control, name: "trackAsAsset" });

  const onSubmit = form.handleSubmit(
    (values) => {
      const linkAsset = values.trackAsAsset && values.assetId;
      create.mutate(
        {
          label: values.label.trim(),
          kind: values.kind as FormValues["kind"] &
            (typeof KIND_OPTIONS)[number],
          trackAsAsset: values.trackAsAsset,
          ...(linkAsset ? { assetId: values.assetId } : {}),
        },
        {
          onSuccess: () => {
            toast.success(t("create.createdToast"));
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("create.error")),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>

        {/* stopPropagation: a form inside a Radix Portal still bubbles its submit through the React
            tree to any ancestor form, so guard it defensively (issue #164). */}
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
              name="label"
              rules={{ required: t("create.labelRequired") }}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="node-label" required>
                    {t("create.labelLabel")}
                  </FieldLabel>
                  <Input
                    id="node-label"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    placeholder={t("create.labelPlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="kind"
              rules={{ required: t("create.kindRequired") }}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="node-kind" required>
                    {t("create.kindLabel")}
                  </FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="node-kind"
                      className="w-full"
                      aria-invalid={fieldState.invalid || undefined}
                    >
                      <SelectValue placeholder={t("create.kindPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {KIND_OPTIONS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`kind.${kind}`)}
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
              name="trackAsAsset"
              render={({ field }) => (
                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor="node-track-asset">
                      {t("create.trackAsAssetLabel")}
                    </FieldLabel>
                    <Switch
                      id="node-track-asset"
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked);
                        // Clear any picked asset when turning tracking off — a graph-only node carries
                        // no asset, and sending an assetId with trackAsAsset:false is a 400 (§5).
                        if (!checked) form.setValue("assetId", "");
                      }}
                    />
                  </div>
                  <FieldDescription>
                    {t("create.trackAsAssetDescription")}
                  </FieldDescription>
                </Field>
              )}
            />

            {trackAsAsset ? (
              <Controller
                control={form.control}
                name="assetId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="node-asset">
                      {t("create.linkAssetLabel")}
                    </FieldLabel>
                    <AssetCombobox
                      id="node-asset"
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder={t("create.linkAssetPlaceholder")}
                      searchPlaceholder={t("create.linkAssetSearch")}
                      emptyText={t("create.linkAssetEmpty")}
                    />
                    <FieldDescription>
                      {t("create.linkAssetDescription")}
                    </FieldDescription>
                  </Field>
                )}
              />
            ) : null}
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={create.isPending}>
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
