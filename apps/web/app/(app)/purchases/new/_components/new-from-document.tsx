"use client";

import { ArrowPathIcon, DocumentMagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { uploadAttachment } from "@/lib/api/endpoints/attachments";
import { updatePurchaseOrder } from "@/lib/api/endpoints/purchase-orders";
import { useCreatePurchaseOrder, useExtractionStatus } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { fileProblem, maxBytesFor, referenceFromFileName } from "@/lib/purchases/extraction";
import { runExclusive } from "@/lib/purchases/submit-guard";

/** Bytes → whole megabytes, rounded down, for the messages. */
function toMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

/**
 * *New purchase from a document* (ADR-0099 §11, Phase 2 #1477) — offered on *New purchase* only while
 * document extraction is available to this person, and absent otherwise (the form below is the way in).
 *
 * Extraction reads a document already attached to a purchase, and a purchase must be identifiable to exist
 * (a supplier, a reference or a line — §2). So picking a file: creates a DRAFT purchase whose reference
 * stands in as the file name, attaches the file, and opens the review, which reads it once. The review fills
 * that stand-in like an empty field and marks the purchase as ordered when it is saved. If anything stops
 * half-way, the draft purchase keeps the document and can be filled by hand.
 */
export function NewFromDocument() {
  const t = useTranslations("purchases.extraction.newFromDocument");
  const router = useRouter();
  const canWrite = useCan("purchaseOrder:write");
  const { data: status } = useExtractionStatus({ enabled: canWrite });
  const create = useCreatePurchaseOrder();
  const input = useRef<HTMLInputElement | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  if (!status?.available) return null;
  const maxMb = toMb(status.maxBytes);

  async function start(file: File) {
    if (!status) return;
    const problem = fileProblem(status, file);
    if (problem) {
      toast.error(
        problem === "type"
          ? t("wrongType", { name: file.name })
          : t("tooLarge", { name: file.name, max: toMb(maxBytesFor(status, file.type)) }),
      );
      return;
    }
    setBusy(true);
    try {
      const reference = referenceFromFileName(file.name);
      const purchase = await create.mutateAsync({ status: "DRAFT", reference });
      let attachmentId: string;
      try {
        const attachment = await uploadAttachment("purchaseOrder", purchase.id, file);
        attachmentId = attachment.id;
        // The stand-in must read as the stored name, which the server may have normalized.
        const stored = referenceFromFileName(attachment.originalName);
        if (stored !== reference) await updatePurchaseOrder(purchase.id, { reference: stored });
      } catch (error) {
        notifyError(error, t("uploadError"));
        router.push(`/purchases/${purchase.id}`);
        return;
      }
      router.push(`/purchases/${purchase.id}/review/${attachmentId}?read=1`);
    } catch (error) {
      notifyError(error, t("createError"));
    } finally {
      setBusy(false);
    }
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void runExclusive(running, () => start(file));
  }

  return (
    <Callout tone="info" icon={<DocumentMagnifyingGlassIcon />}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t("title")}</p>
          <p className="text-muted-foreground">{t("description", { max: maxMb })}</p>
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
    </Callout>
  );
}
