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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAssignUser } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";

interface AssignUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  /** Users already actively assigned to this asset — hidden from the select. */
  excludeUserIds?: string[];
}

/**
 * Assign a user to an asset (opens an AssetAssignment). Only active users who
 * aren't already current owners are selectable. Notes are optional. Author of the
 * assignment (`assignedById`) is omitted — set by auth once it lands (ADR-0022).
 */
export function AssignUserDialog({
  open,
  onOpenChange,
  assetId,
  excludeUserIds = [],
}: AssignUserDialogProps) {
  const { data: users } = useUsers();
  const assign = useAssignUser();
  const [userId, setUserId] = useState("");
  const [notes, setNotes] = useState("");

  function handleOpenChange(next: boolean) {
    if (!next) {
      setUserId("");
      setNotes("");
    }
    onOpenChange(next);
  }

  function handleAssign() {
    if (!userId) {
      toast.error("Choose a user to assign");
      return;
    }
    const trimmed = notes.trim();
    assign.mutate(
      { assetId, userId, ...(trimmed ? { notes: trimmed } : {}) },
      {
        onSuccess: () => {
          toast.success("User assigned");
          handleOpenChange(false);
        },
        onError: (error) =>
          notifyError(error, "Couldn't assign the user"),
      },
    );
  }

  const available = (users ?? []).filter(
    (user) => user.isActive && !excludeUserIds.includes(user.id),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign user</DialogTitle>
          <DialogDescription>
            Record a new owner for this asset. Releasing a previous owner is a
            separate action.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="assign-user">User</FieldLabel>
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
                <SelectTrigger id="assign-user" className="w-full">
                  <SelectValue
                    placeholder={
                      available.length > 0
                        ? "Select a user"
                        : "No assignable users"
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
            <FieldLabel htmlFor="assign-notes">Notes</FieldLabel>
            <Textarea
              id="assign-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional — e.g. primary work laptop"
              rows={2}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={assign.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleAssign} disabled={assign.isPending}>
            {assign.isPending && <ArrowPathIcon className="animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
