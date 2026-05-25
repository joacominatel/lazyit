"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { Location } from "@lazyit/shared";
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
import { useDeleteLocation } from "@/lib/api/hooks/use-location-mutations";

interface DeleteLocationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location;
}

/** Confirmation for a (soft) delete. Stays open on error; closes on success. */
export function DeleteLocationDialog({
  open,
  onOpenChange,
  location,
}: DeleteLocationDialogProps) {
  const deleteLocation = useDeleteLocation();

  function handleDelete() {
    deleteLocation.mutate(location.id, {
      onSuccess: () => {
        toast.success("Location deleted");
        onOpenChange(false);
      },
      onError: (error) =>
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "Couldn't delete location",
        ),
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete location?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{location.name}</span>{" "}
            will be archived — a soft delete that hides it from the list without
            permanently erasing it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteLocation.isPending}>
            Cancel
          </AlertDialogCancel>
          {/* Plain destructive button (not AlertDialogAction) so we control the
              pending spinner and only close on success. */}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteLocation.isPending}
          >
            {deleteLocation.isPending && (
              <ArrowPathIcon className="animate-spin" />
            )}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
