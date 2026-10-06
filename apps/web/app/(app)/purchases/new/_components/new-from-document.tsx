"use client";

import { ArrowPathIcon, DocumentMagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useRef } from "react";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { toWholeMb } from "@/lib/purchases/start-from-document";
import { DocumentDropStage, useDocumentStart } from "../../_components/document-start";

/** Absent unless extraction is available to this person; the form below is the way in otherwise (ADR-0099 §11). */
export function NewFromDocument() {
  const t = useTranslations("purchases.extraction.newFromDocument");
  const documentStart = useDocumentStart();
  const input = useRef<HTMLInputElement | null>(null);

  if (!documentStart) return null;
  const { status, started, start } = documentStart;
  const busy = started !== null;

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    start(files);
  }

  return (
    <Callout tone="info" icon={<DocumentMagnifyingGlassIcon />}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t("title")}</p>
          <p className="text-muted-foreground">{t("description", { max: toWholeMb(status.maxBytes) })}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <ArrowPathIcon className="animate-spin" /> : <DocumentMagnifyingGlassIcon />}
          {t("action")}
        </Button>
        <input
          ref={input}
          type="file"
          accept={status.mediaTypes.join(",")}
          className="sr-only"
          aria-label={t("action")}
          onChange={onPick}
          tabIndex={-1}
        />
      </div>
      <DocumentDropStage start={documentStart} />
    </Callout>
  );
}
