"use client";

import { PlusIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EntityKey } from "@/lib/entity-key";

/**
 * Pairs a select (the `children`) with a "+ New" button that opens a create dialog, so a missing
 * related entity (a location, category, model, user…) can be created without leaving the form. The
 * dialog is provided via `renderDialog`; on success it should call its own `onCreated` to select the
 * new record (the create mutation already refetches the options). Issue #25.
 */
export function CreatableField({
  entityKey,
  renderDialog,
  children,
}: {
  /**
   * Stable entity key from the closed set ({@link EntityKey}) — the "+ New" button resolves its
   * localized, correctly-gendered tooltip internally (issue #204). Never a raw English word.
   */
  entityKey: EntityKey;
  renderDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("shared");
  const [open, setOpen] = useState(false);
  const newLabel = t("field.newEntity", { label: entityKey });
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
