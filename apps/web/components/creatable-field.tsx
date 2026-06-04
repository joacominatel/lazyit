"use client";

import { PlusIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Pairs a select (the `children`) with a "+ New" button that opens a create dialog, so a missing
 * related entity (a location, category, model, user…) can be created without leaving the form. The
 * dialog is provided via `renderDialog`; on success it should call its own `onCreated` to select the
 * new record (the create mutation already refetches the options). Issue #25.
 */
export function CreatableField({
  label,
  renderDialog,
  children,
}: {
  /** Lowercase entity label for the button's tooltip, e.g. "location". */
  label: string;
  renderDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("shared");
  const [open, setOpen] = useState(false);
  const newLabel = t("field.newEntity", { label });
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={newLabel}
          title={newLabel}
          onClick={() => setOpen(true)}
        >
          <PlusIcon />
        </Button>
      </div>
      {renderDialog({ open, onOpenChange: setOpen })}
    </>
  );
}
