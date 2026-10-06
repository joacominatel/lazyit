"use client";

import { DocumentMagnifyingGlassIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import type { AiSettings } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { HelpTip } from "@/components/help-tip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import { buildUpdate, documentExtractionAvailability } from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";
import { AiFieldLabel } from "./ai-field-label";

/**
 * Settings → AI: purchase *Document extraction* (ADR-0099 §11, #1477). Its own switch, OFF by default and on
 * every upgraded instance: turning it on lets a person send a document attached to a purchase — an invoice,
 * a quote, a delivery note, with its supplier, prices and tax IDs — to the configured provider to draft the
 * purchase. The card says so plainly next to the switch (the shared `AI_DOCUMENT_EXTRACTION_DISCLOSURE`,
 * localized). It needs the assistant on and a provider that reads documents; otherwise the switch is disabled
 * with the reason — but stays usable while on, so it can always be turned off. The page is admin-gated (`AdminGate`); the API
 * is the real gate.
 */
export function AiDocumentExtractionSection({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.documentExtraction");
  const tLinks = useTranslations("aiSettings.links");
  const save = useAiConfigSave();
  const availability = documentExtractionAvailability(settings);
  const available = availability === "available";
  const enabled = settings.documentExtractionEnabled === true;
  const active = enabled && available;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <DocumentMagnifyingGlassIcon className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>{t("title")}</CardTitle>
            <HelpTip topic={t("title")} href={tLinks("documentExtraction")}>
              <p>{t("description")}</p>
            </HelpTip>
          </div>
          <StatusBadge tone={active ? "success" : "neutral"}>{active ? t("on") : t("off")}</StatusBadge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <AiFieldLabel
              htmlFor="ai-document-extraction-enabled"
              className="font-medium"
              help={<p>{t("switch.description")}</p>}
            >
              {t("switch.label")}
            </AiFieldLabel>
          </div>
          <Switch
            id="ai-document-extraction-enabled"
            checked={enabled}
            disabled={save.isPending || (!available && !enabled)}
            onCheckedChange={(checked) =>
              save.save(buildUpdate(settings, { documentExtractionEnabled: checked }), () =>
                toast.success(checked ? t("savedOn") : t("savedOff")),
              )
            }
          />
        </Field>
        <AiErrorNotice error={save.error} />

        {!available ? (
          <Callout tone="warning" icon={<InformationCircleIcon />}>
            <p className="text-sm">{t(`availability.${availability}`)}</p>
          </Callout>
        ) : null}

        <Callout tone="info" icon={<InformationCircleIcon />}>
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">{t("disclosure.title")}</p>
            <p>{t("disclosure.egress")}</p>
            <p>{t("disclosure.review")}</p>
          </div>
        </Callout>
      </CardContent>
    </Card>
  );
}
