"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { toast } from "sonner";
import { UserFormDialog } from "@/app/(app)/users/_components/user-form-dialog";
import { CreatableField } from "@/components/creatable-field";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGrantAccess } from "@/lib/api/hooks/use-access-grant-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** "YYYY-MM-DD" from a date input → ISO datetime (undefined when empty). */
function dateInputToIso(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

interface GrantAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
}

/**
 * Grant a user access to an application (opens an AccessGrant). Multi-grant is allowed, so users are
 * not filtered out by existing grants. `accessLevel` is free-form (each app owns its vocabulary);
 * `expiresAt` is informative only (no auto-revoke — ADR-0023). The grantor (`grantedById`) comes
 * from the `X-User-Id` shim and may be null (anonymous) by design.
 */
export function GrantAccessDialog({
  open,
  onOpenChange,
  applicationId,
}: GrantAccessDialogProps) {
  const { data: users } = useUsers();
  const grant = useGrantAccess();
  const [userId, setUserId] = useState("");
  const [accessLevel, setAccessLevel] = useState("");
  const [expiresAt, setExpiresAt] = useState(""); // YYYY-MM-DD
  const [notes, setNotes] = useState("");

  function handleOpenChange(next: boolean) {
    if (!next) {
      setUserId("");
      setAccessLevel("");
      setExpiresAt("");
      setNotes("");
    }
    onOpenChange(next);
  }

  function handleGrant() {
    if (!userId) {
      toast.error("Choose a user to grant access");
      return;
    }
    const level = accessLevel.trim();
    const note = notes.trim();
    grant.mutate(
      {
        applicationId,
        userId,
        ...(level ? { accessLevel: level } : {}),
        ...(expiresAt ? { expiresAt: dateInputToIso(expiresAt) } : {}),
        ...(note ? { notes: note } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Access granted");
          handleOpenChange(false);
        },
        onError: (error) =>
          toast.error(errorMessage(error, "Couldn't grant access")),
      },
    );
  }

  const available = (users ?? []).filter((user) => user.isActive);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Grant access</DialogTitle>
          <DialogDescription>
            Give a user access to this application. A user may hold several grants
            at different access levels.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="grant-user">User</FieldLabel>
            <CreatableField
              label="user"
              renderDialog={(dialog) => (
                <UserFormDialog
                  open={dialog.open}
                  onOpenChange={dialog.onOpenChange}
                  onCreated={(user) => setUserId(user.id)}
                />
              )}
            >
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger id="grant-user" className="w-full">
                  <SelectValue
                    placeholder={
                      available.length > 0 ? "Select a user" : "No active users"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {available.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.firstName} {user.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CreatableField>
          </Field>

          <Field>
            <FieldLabel htmlFor="grant-level">Access level</FieldLabel>
            <Input
              id="grant-level"
              value={accessLevel}
              onChange={(event) => setAccessLevel(event.target.value)}
              placeholder="admin, developer, viewer…"
            />
            <FieldDescription>
              Optional, free-form — whatever this application calls its roles.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="grant-expires">Expires</FieldLabel>
            <Input
              id="grant-expires"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <FieldDescription>
              Optional and informative — access is not auto-revoked at expiry.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="grant-notes">Notes</FieldLabel>
            <Textarea
              id="grant-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional — e.g. requested for the Q3 migration"
              rows={2}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={grant.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleGrant} disabled={grant.isPending}>
            {grant.isPending && <ArrowPathIcon className="animate-spin" />}
            Grant access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
