"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useAcknowledgeAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { useInvalidateAssets } from "@/lib/api/hooks/use-assets";
import { notifyError } from "@/lib/api/notify-error";
import { useTranslations } from "next-intl";

/**
 * Self-service "Acknowledge receipt" dialog (ADR-0089 Part B, #1029). The assignee confirms they took
 * possession of the asset checked out to them, with an optional note. It calls the self-scoped
 * `POST /asset-assignments/:id/acknowledge` (the API verifies the caller owns this active assignment).
 * A set-once transition, so a 409 (already acknowledged / released / raced) is handled GRACEFULLY: a
 * friendly toast plus a cache refresh so the panel repaints its now-acknowledged state, not a raw error.
 */
export function AcknowledgeAssignmentDialog({
  open,
  onOpenChange,
  assignmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assignmentId: string;
}) {
  const t = useTranslations("assets.acknowledge");
  const tc = useTranslations("common");
  const acknowledge = useAcknowledgeAssignment();
  const invalidate = useInvalidateAssets();
  // Fresh state per open: the only caller mounts this dialog conditionally (unmounts on close), so the
  // note starts empty every time without a reset effect.
  const [note, setNote] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = note.trim();
    acknowledge.mutate(
      { id: assignmentId, data: trimmed ? { note: trimmed } : {} },
      {
        onSuccess: () => {
          toast.success(t("acknowledgedToast"));
          onOpenChange(false);
        },
        onError: (error) => {
          // Set-once: the assignment was already acknowledged / released (or a concurrent action won
          // the race). Not a failure the user can fix — nudge them and refresh so the panel updates.
          if (error instanceof ApiError && error.status === 409) {
            toast.info(t("conflictToast"));
            void invalidate();
            onOpenChange(false);
            return;
          }
          notifyError(error, t("acknowledgeError"));
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <form id="acknowledge-form" onSubmit={handleSubmit} noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="acknowledge-note">{t("note")}</FieldLabel>
              <Textarea
                id="acknowledge-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder={t("notePlaceholder")}
              />
            </Field>
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={acknowledge.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="submit"
            form="acknowledge-form"
            disabled={acknowledge.isPending}
          >
            {acknowledge.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
