"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { type EditableRole, type Role } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface RoleSegmentedProps {
  /** The role currently being edited. */
  value: EditableRole;
  /** Switch the edited role (deep-links via the page's `?role=` param). */
  onChange: (role: EditableRole) => void;
  /** Live holder counts per role (from the user directory). `undefined` while loading. */
  counts: Record<Role, number> | undefined;
  /** True for a role with unsaved staged edits (shows a dot on the segment). */
  isDirty: (role: EditableRole) => boolean;
}

/** The editable role keys; the visible label is translated at render. */
const SEGMENT_ROLES: EditableRole[] = ["MEMBER", "VIEWER"];

/**
 * The role picker (segmented control). ADMIN is shown FIRST but LOCKED ("Full" + a lock) — it is
 * immutable/full (ADR-0046) and never selectable for edit. MEMBER and VIEWER are the editable
 * segments; exactly one is active at a time (one role edited at a time, deep-linkable via `?role=`).
 * Each segment shows its live holder count; an edited (dirty) segment shows an unsaved dot so an admin
 * can tell both roles still hold pending edits before saving (the PUT writes both).
 */
export function RoleSegmented({
  value,
  onChange,
  counts,
  isDirty,
}: RoleSegmentedProps) {
  const t = useTranslations("settings");
  return (
    <div
      className="inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/40 p-1"
      role="group"
      aria-label={t("roles.permissions.segmented.ariaLabel")}
    >
      {/* ADMIN — locked, not a button. */}
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground"
        aria-disabled="true"
        title={t("roles.permissions.segmented.adminTitle")}
      >
        <LockClosedIcon className="size-3.5" />
        {t("roles.permissions.segmented.admin")}
        <span className="text-xs tabular-nums opacity-70">
          {counts ? counts.ADMIN : "—"}
        </span>
        <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
          {t("roles.permissions.segmented.full")}
        </span>
      </span>

      {SEGMENT_ROLES.map((role) => {
        const active = value === role;
        const dirty = isDirty(role);
        return (
          <button
            key={role}
            type="button"
            onClick={() => onChange(role)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`roles.permissions.segmented.${role === "MEMBER" ? "member" : "viewer"}`)}
            <span className="text-xs tabular-nums opacity-70">
              {counts ? counts[role] : "—"}
            </span>
            {dirty && (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                aria-label={t("roles.permissions.segmented.unsavedChanges")}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
