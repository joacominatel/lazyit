"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
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
import { useImportSession, useStartImport } from "@/lib/api/hooks/use-imports";
import { useImportError } from "../use-import-error";

/** CSV or JSON only — .xlsx is rejected server-side with an actionable message (ADR-0069 §12). */
const ACCEPT = ".csv,.json,text/csv,application/json";

/**
 * Step 1 — Upload + entity (ADR-0069 §1). The operator picks the entity (Asset only in phase 1) and a
 * CSV/JSON file, then `POST /imports` returns a `sessionId`; we poll the session until it reaches
 * PARSED and hand the id up. A FAILED parse surfaces the PII-free reason and re-enables the form
 * (the parse is permanent, never "try again" framed). 413/403/4xx on upload route through the shared
 * error mapper.
 */
export function UploadStep({ onParsed }: { onParsed: (sessionId: string) => void }) {
  const t = useTranslations("imports");
  const { notify } = useImportError();

  const [file, setFile] = useState<File | null>(null);
  // The entity is fixed to "asset" in phase 1, but the control is rendered (disabled extras) so the
  // operator sees the scope; the value is always "asset".
  const entity = "asset" as const;

  // sessionId drives the parse poll; once PARSED we hand it up and this step unmounts.
  const [pollId, setPollId] = useState<string | undefined>();
  // One-shot guards so the PARSED hand-up and the FAILED toast each fire exactly once per session,
  // even under React's dev double-invoke. Read only inside effects (never during render).
  const handedUpRef = useRef<string | undefined>(undefined);
  const notifiedRef = useRef<string | undefined>(undefined);

  const start = useStartImport();
  const session = useImportSession(pollId);
  const status = session.data?.status;
  const terminalFailed = status === "FAILED" || status === "EXPIRED";

  // PARSED → advance (the parent unmounts this step). FAILED/EXPIRED → toast the PII-free reason and
  // re-enable the form (the stale poll stops itself once the status is terminal — no setState here).
  useEffect(() => {
    if (!pollId) return;
    if (status === "PARSED" && handedUpRef.current !== pollId) {
      handedUpRef.current = pollId;
      onParsed(pollId);
    } else if (terminalFailed && notifiedRef.current !== pollId) {
      notifiedRef.current = pollId;
      const message = session.data?.error?.message;
      notify(message ? new Error(message) : undefined, "parse");
    }
  }, [status, pollId, terminalFailed, session.data?.error?.message, onParsed, notify]);

  // Parsing while the upload is in flight, or while a session poll hasn't reached a terminal state.
  const isParsing =
    start.isPending ||
    (pollId !== undefined && status !== "PARSED" && !terminalFailed);

  function handleUpload() {
    if (!file) {
      toast.error(t("upload.chooseFile"));
      return;
    }
    start.mutate(
      { file, entity },
      {
        onSuccess: ({ sessionId }) => setPollId(sessionId),
        onError: (error) => notify(error, "upload"),
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("upload.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("upload.description")}</p>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="import-entity">{t("upload.entityLabel")}</FieldLabel>
          <Select value={entity} disabled>
            <SelectTrigger id="import-entity" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asset">{t("upload.entityAsset")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="import-file">{t("upload.fileLabel")}</FieldLabel>
          <Input
            id="import-file"
            type="file"
            accept={ACCEPT}
            disabled={isParsing}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <FieldDescription>{t("upload.fileHint")}</FieldDescription>
        </Field>
      </FieldGroup>

      {isParsing && (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />
          {start.isPending ? t("upload.parsing") : t("upload.parsingHint")}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={handleUpload} disabled={isParsing || !file}>
          {isParsing && <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />}
          {isParsing ? t("upload.uploading") : t("upload.submit")}
        </Button>
      </div>
    </div>
  );
}
