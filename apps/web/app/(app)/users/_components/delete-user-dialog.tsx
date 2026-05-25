"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDeleteUser } from "@/lib/api/hooks/use-user-mutations";

interface DeleteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User;
}

/** Confirmation for a (soft) delete. Stays open on error; closes on success. */
export function DeleteUserDialog({
  open,
  onOpenChange,
  user,
}: DeleteUserDialogProps) {
  const deleteUser = useDeleteUser();

  function handleDelete() {
    deleteUser.mutate(user.id, {
      onSuccess: () => {
        toast.success("User deleted");
        onOpenChange(false);
      },
      onError: (error) =>
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "Couldn't delete user",
        ),
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete user?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">
              {user.firstName} {user.lastName}
            </span>{" "}
            will be archived — a soft delete that hides them from the list
            without erasing their history. To keep a person on record but disable
            them, set them inactive instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteUser.isPending}>
            Cancel
          </AlertDialogCancel>
          {/* Plain destructive button (not AlertDialogAction) so we control the
              pending spinner and only close on success. */}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteUser.isPending}
          >
            {deleteUser.isPending && <ArrowPathIcon className="animate-spin" />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
