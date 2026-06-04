"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AccessGrant } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useUpdateGrantExpiry,
  useUpdateGrantNotes,
} from "@/lib/api/hooks/use-access-grant-mutations";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";

/** "YYYY-MM-DD" from a date input → ISO datetime (null when empty — clears the expiry). */
function dateInputToIso(value: string): string | null {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}

/** ISO datetime → "YYYY-MM-DD" for the date input (empty when null). */
function isoToDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

interface EditGrantDialogProps {
  /** The grant to edit, or null when the dialog is closed. */
  grant: AccessGrant | null;
  onOpenChange: (open: boolean) => void;
  /** Grantee name, for the dialog header. */
  userName: string;
}

/**
 * Edit a live grant's **expiry** and **notes** — the only mutable fields (identity is immutable;
 * ADR-0023). Backs the two dedicated endpoints (`PATCH /access-grants/:id/expiry` and `/notes`); the
 * dialog only fires the call for a field that actually changed, so an unchanged field isn't touched.
 * `accessLevel` is set at grant time and not edited here (revoke + re-grant to change a role).
 */
export function EditGrantDialog({
  grant,
  onOpenChange,
  userName,
}: EditGrantDialogProps) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");
  const canGrant = useCan("accessGrant:grant");
  const updateExpiry = useUpdateGrantExpiry();
  const updateNotes = useUpdateGrantNotes();
  const [expiresAt, setExpiresAt] = useState(""); // YYYY-MM-DD
  const [notes, setNotes] = useState("");

  // Seed the form from the grant each time a different grant opens the dialog. Done during render
  // (the "derive state from props" pattern, like assets/page.tsx) rather than in an effect, so the
  // fields reset in the same pass the grant changes — no cascading-render lint and no stale flash.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (grant && grant.id !== seededId) {
    setSeededId(grant.id);
    setExpiresAt(isoToDateInput(grant.expiresAt));
    setNotes(grant.notes ?? "");
  }

  const isPending = updateExpiry.isPending || updateNotes.isPending;

  async function handleSave() {
    if (!grant) return;
    const nextExpiryIso = dateInputToIso(expiresAt);
    const expiryChanged = nextExpiryIso !== grant.expiresAt;
    const trimmedNotes = notes.trim();
    const nextNotes = trimmedNotes === "" ? null : trimmedNotes;
    const notesChanged = nextNotes !== (grant.notes ?? null);

    if (!expiryChanged && !notesChanged) {
      onOpenChange(false);
      return;
    }

    try {
      if (expiryChanged) {
        await updateExpiry.mutateAsync({
          id: grant.id,
          data: { expiresAt: nextExpiryIso },
        });
      }
      if (notesChanged) {
        await updateNotes.mutateAsync({
          id: grant.id,
          data: { notes: nextNotes },
        });
      }
      toast.success(t("access.updatedToast"));
      onOpenChange(false);
    } catch (error) {
      notifyError(error, t("access.updateError"));
    }
  }

  // RBAC v2: editing a grant is an AccessGrant mutation gated on `accessGrant:grant` (ADR-0046).
  // Render nothing without it so the affordance never appears; the API's permission guard is the real
  // gate (fails closed).
  if (!canGrant) return null;

  return (
    <Dialog open={grant != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("access.editTitle")}</DialogTitle>
          <DialogDescription>
            {t("access.editDescriptionPrefix")}
            <span className="font-medium text-foreground">{userName}</span>
            {grant?.accessLevel
              ? t("access.editDescriptionLevel", { level: grant.accessLevel })
              : ""}
            {t("access.editDescriptionSuffix")}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="edit-grant-expires">
              {t("access.expiresLabel")}
            </FieldLabel>
            <Input
              id="edit-grant-expires"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <FieldDescription>
              {t("access.editExpiresDescription")}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="edit-grant-notes">
              {t("access.notesLabel")}
            </FieldLabel>
            <Textarea
              id="edit-grant-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={t("access.notesPlaceholder")}
              rows={2}
            />
            <FieldDescription>
              {t("access.editNotesDescription")}
            </FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={handleSave} disabled={isPending}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {t("access.editSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
