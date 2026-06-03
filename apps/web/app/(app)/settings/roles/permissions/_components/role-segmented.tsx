"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { type EditableRole, type Role } from "@lazyit/shared";
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

const SEGMENTS: { role: EditableRole; label: string }[] = [
  { role: "MEMBER", label: "Member" },
  { role: "VIEWER", label: "Viewer" },
];

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
  return (
    <div
      className="inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/40 p-1"
      role="group"
      aria-label="Choose a role to edit"
    >
      {/* ADMIN — locked, not a button. */}
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground"
        aria-disabled="true"
        title="Admin has full access and cannot be edited."
      >
        <LockClosedIcon className="size-3.5" />
        Admin
        <span className="text-xs tabular-nums opacity-70">
          {counts ? counts.ADMIN : "—"}
        </span>
        <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
          Full
        </span>
      </span>

      {SEGMENTS.map(({ role, label }) => {
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
            {label}
            <span className="text-xs tabular-nums opacity-70">
              {counts ? counts[role] : "—"}
            </span>
            {dirty && (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                aria-label="Unsaved changes"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
