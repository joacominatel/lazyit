"use client";

import type { AssetListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/user-avatar";

const MAX_SHOWN = 4;

/**
 * The trimmed owner-assignment shape carried by the lean asset list
 * (`AssetListItem`). The lean projection now carries `user.deletedAt` (re-added in
 * the ADR-0030 amendment, 2026-06-01) — `null` for a live owner, an ISO timestamp
 * for a departed (soft-deleted) one — so the list dims a departed owner exactly
 * like the detail read. The intersection just keeps the field optional so this
 * component also accepts any caller passing the full detail shape.
 */
type OwnerAssignment = AssetListItem["activeAssignments"][number] & {
  user: { deletedAt?: string | null };
};

/**
 * Overlapping avatars of an asset's active owners, with a "+N" overflow chip.
 * Soft-deleted owners (a person who left but whose assignment isn't released yet)
 * render dimmed/grayscale with a "deactivated" hint — they linger until released.
 */
export function StackedOwnerAvatars({
  assignments,
}: {
  assignments: OwnerAssignment[];
}) {
  const t = useTranslations("assets.list");
  if (assignments.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const shown = assignments.slice(0, MAX_SHOWN);
  const extra = assignments.length - shown.length;

  return (
    <AvatarGroup>
      {shown.map(({ id, user }) => {
        const gone = user.deletedAt != null;
        return (
          <UserAvatar
            key={id}
            size="sm"
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            title={`${user.firstName} ${user.lastName}${gone ? ` · ${t("deactivatedSuffix")}` : ""}`}
            className={gone ? "opacity-50 grayscale" : undefined}
          />
        );
      })}
      {extra > 0 && <AvatarGroupCount>+{extra}</AvatarGroupCount>}
    </AvatarGroup>
  );
}
