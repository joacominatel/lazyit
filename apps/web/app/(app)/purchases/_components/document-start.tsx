"use client";

import { ArrowPathIcon, DocumentArrowUpIcon, DocumentIcon } from "@heroicons/react/24/outline";
import type { PurchaseExtractionStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { DrawnCheck } from "@/components/drawn-check";
import { uploadAttachment } from "@/lib/api/endpoints/attachments";
import { updatePurchaseOrder } from "@/lib/api/endpoints/purchase-orders";
import { useCreatePurchaseOrder, useExtractionStatus } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useMounted } from "@/lib/hooks/use-mounted";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  canStartFromDocument,
  pickFile,
  START_STEPS,
  type StartStep,
  startFromDocument,
  toWholeMb,
} from "@/lib/purchases/start-from-document";
import { runExclusive } from "@/lib/purchases/submit-guard";
import { cn } from "@/lib/utils";
import {
  FILE_DRAG_STALE_MS,
  type FileDragInput,
  isFileDragging,
  NO_FILE_DRAG,
  nextFileDrag,
} from "@/lib/utils/file-drag";
import { formatBytes } from "@/lib/utils/format";

export interface StartedDocument {
  name: string;
  size: number;
  step: StartStep;
}

export interface DocumentStart {
  status: PurchaseExtractionStatus;
  started: StartedDocument | null;
  start: (files: ArrayLike<File> | null | undefined) => void;
}

const FAILED_KEY = { create: "createError", upload: "uploadError", rename: "renameError" } as const;
const DONE_KEY = { create: "created", attach: "attached", open: "open" } as const;

/** `null` when the person cannot start a purchase from a document here. */
export function useDocumentStart(): DocumentStart | null {
  const t = useTranslations("purchases.extraction.newFromDocument");
  const router = useRouter();
  const canWrite = useCan("purchaseOrder:write");
  const { data: status } = useExtractionStatus({ enabled: canWrite });
  const create = useCreatePurchaseOrder();
  const lock = useRef(false);
  const [started, setStarted] = useState<StartedDocument | null>(null);

  if (!status || !canStartFromDocument(canWrite, status)) return null;
  const caps = status;

  function start(files: ArrayLike<File> | null | undefined) {
    void runExclusive(lock, async () => {
      const pick = pickFile(caps, files);
      if (pick.kind === "none") return;
      if (pick.kind === "refuse") {
        toast.error(t(pick.refusal.key, pick.refusal.values));
        return;
      }
      const { file } = pick;
      if (pick.several) toast.info(t("oneAtATime", { name: file.name }));
      setStarted({ name: file.name, size: file.size, step: "create" });
      return startFromDocument(file, {
        create: (reference) => create.mutateAsync({ status: "DRAFT", reference }),
        upload: (purchaseId, picked) => uploadAttachment("purchaseOrder", purchaseId, picked),
        rename: (purchaseId, reference) => updatePurchaseOrder(purchaseId, { reference }),
        open: (href) => router.push(href),
        step: (step) => setStarted((current) => current && { ...current, step }),
        failed: (stage, error) => {
          notifyError(error, t(FAILED_KEY[stage]));
          if (stage !== "rename") setStarted(null);
        },
      });
    });
  }

  return { status, started, start };
}

function useWindowFileDrag(onDrop: (files: FileList) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const dropped = useEffectEvent(onDrop);

  useEffect(() => {
    let state = NO_FILE_DRAG;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

    function check() {
      const on = isFileDragging(state, performance.now());
      setDragging(on);
      clearTimeout(silence);
      if (on) silence = setTimeout(check, FILE_DRAG_STALE_MS);
    }
    function feed(kind: FileDragInput["kind"], event: DragEvent) {
      state = nextFileDrag(state, { kind, files: isFileDrag(event), at: performance.now() });
      check();
    }
    const enter = (event: DragEvent) => feed("enter", event);
    const leave = (event: DragEvent) => feed("leave", event);
    function over(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      feed("over", event);
    }
    function drop(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      feed("drop", event);
      dropped(event.dataTransfer!.files);
    }
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      clearTimeout(silence);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return dragging;
}

/** The whole page as a drop target while a file is dragged over it, then the card of the document being started. */
export function DocumentDropStage({ start }: { start: DocumentStart }) {
  const dragging = useWindowFileDrag(start.start);
  const mounted = useMounted();
  // The route wrapper's fade-in is a stacking context; from inside it the overlay would sit under the assistant panel.
  if (!mounted) return null;
  return createPortal(
    <DropOverlay status={start.status} started={start.started} dragging={dragging} />,
    document.body,
  );
}

export function DropOverlay({
  status,
  started,
  dragging,
}: {
  status: PurchaseExtractionStatus;
  started: StartedDocument | null;
  dragging: boolean;
}) {
  const t = useTranslations("purchases.extraction.newFromDocument");
  const targeting = dragging && started === null;
  const shown = targeting || started !== null;

  return (
    <div
      aria-hidden={started ? undefined : true}
      data-state={started ? "starting" : targeting ? "dragging" : "idle"}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 sm:p-8 motion-safe:transition-opacity motion-safe:duration-150",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {started ? (
        <DocumentStartCard started={started} />
      ) : (
        <div
          className={cn(
            "flex size-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-foreground/30 p-6 text-center motion-safe:transition-transform motion-safe:duration-200",
            targeting ? "scale-100" : "motion-safe:scale-[0.98]",
          )}
        >
          <span className="flex size-12 items-center justify-center rounded-xl bg-pillar-inventory/10">
            <DocumentArrowUpIcon className="size-6 text-pillar-inventory" aria-hidden />
          </span>
          <p className="text-section">{t("dropTitle")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("dropDescription", { max: toWholeMb(status.maxBytes) })}
          </p>
        </div>
      )}
    </div>
  );
}

export function DocumentStartCard({ started }: { started: StartedDocument }) {
  const t = useTranslations("purchases.extraction.newFromDocument");
  const at = START_STEPS.indexOf(started.step);

  return (
    <div
      role="status"
      aria-label={t("startingFrom", { name: started.name })}
      className="w-full max-w-sm rounded-xl border bg-card p-5 text-card-foreground shadow-e3 motion-safe:animate-rise-in"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-pillar-inventory/10">
          <DocumentIcon className="size-6 text-pillar-inventory" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{started.name}</p>
          <p className="font-mono text-xs text-muted-foreground tabular-nums">{formatBytes(started.size)}</p>
        </div>
      </div>
      <ol className="mt-4 space-y-2 border-t pt-4 text-sm">
        {START_STEPS.map((step, index) => {
          const state = index < at ? "done" : index === at ? "active" : "pending";
          return (
            <li
              key={step}
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "flex items-center gap-2",
                state === "active" && "font-medium",
                state === "pending" && "text-muted-foreground",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                {state === "done" ? (
                  <DrawnCheck className="text-success" />
                ) : state === "active" ? (
                  <ArrowPathIcon className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <span className="size-3 rounded-full border border-muted-foreground/50" />
                )}
              </span>
              {t(`steps.${state === "done" ? DONE_KEY[step] : step}`)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
