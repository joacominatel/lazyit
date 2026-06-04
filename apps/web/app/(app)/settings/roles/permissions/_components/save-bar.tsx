"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

interface SaveBarProps {
  /** Hidden when there are no unsaved edits. */
  dirty: boolean;
  /** True while the PUT is in flight. */
  isSaving: boolean;
  /** Revert all staged edits (both roles) back to the saved matrix. */
  onDiscard: () => void;
  /** Validate + save (routes through the consequential confirm if needed). */
  onSave: () => void;
}

/**
 * Sticky save footer (the BatchActionBar visual idiom) shown only when the staged matrix differs from
 * the saved one. Holds Discard (revert both roles) and Save (PUTs the COMPLETE {MEMBER, VIEWER} sets).
 * It sits above the page content with a translucent backdrop so it never hides the toggle the admin
 * just changed.
 */
export function SaveBar({ dirty, isSaving, onDiscard, onSave }: SaveBarProps) {
  const t = useTranslations("settings");
  if (!dirty) return null;
  return (
    <div
      className="sticky bottom-4 z-20 mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center sm:justify-between"
      role="region"
      aria-label={t("roles.permissions.saveBar.ariaLabel")}
    >
      <span className="text-sm font-medium" aria-live="polite">
        {t("roles.permissions.saveBar.message")}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onDiscard} disabled={isSaving}>
          {t("roles.permissions.saveBar.discard")}
        </Button>
        <Button onClick={onSave} disabled={isSaving}>
          {isSaving && <ArrowPathIcon className="animate-spin" />}
          {t("roles.permissions.saveBar.saveChanges")}
        </Button>
      </div>
    </div>
  );
}
