"use client";

import {
  CubeIcon,
  KeyIcon,
  ServerStackIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type {
  ActivityEntityType,
  RecentActivityItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ComponentType, CSSProperties } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarColorFor } from "@/lib/avatar-color";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";

/**
 * Shared timeline-row vocabulary for the unified recent-activity feed — extracted from the
 * dashboard's RecentActivityPanel (Wave 3a) so the Reports/Informes screen can REUSE the exact
 * same row, entity icon/link map and actor avatar without a second copy. The dashboard panel and
 * the Reports timeline now render an identical row; behaviour is unchanged from the extraction.
 */

/**
 * Cap the staggered settle to the first page's worth of rows: beyond this, the rise-in delay is
 * clamped so a long feed (or "Load more"-appended pages) never grows a sluggish cascade — the
 * stagger is a first-mount reveal, not a per-row reflex. ~8 keeps the total under ~190ms.
 */
export const STAGGER_CAP = 8;

/** Per-pillar icon + the area the entity links into. */
export const ENTITY_META: Record<
  ActivityEntityType,
  { icon: ComponentType<{ className?: string }>; href: (id: string) => string }
> = {
  asset: { icon: ServerStackIcon, href: (id) => `/assets/${id}` },
  application: { icon: KeyIcon, href: (id) => `/applications/${id}` },
  consumable: { icon: CubeIcon, href: (id) => `/consumables/${id}` },
  // DEBT-2 (issue #185): the User entity now audits its lifecycle into the feed; the row links to the
  // person's detail page, same `/<area>/:id` pattern as the others.
  user: { icon: UsersIcon, href: (id) => `/users/${id}` },
};

/**
 * Tone classes for the leading icon chip, by pillar (ADR-0049). These chips hold a DECORATIVE
 * glyph (aria-hidden) — a ≥24px mark is exempt from text-AA — so the pillar hue can sit as both
 * tint (`/10` background) and glyph color. Asset + consumable are Inventory (teal); application is
 * Access (indigo); user is Manage (rose, DEBT-2). The pillar tokens carry dark parity, so the
 * hand-written `dark:` variants are gone. Full strings so the Tailwind scanner keeps them.
 */
export const ENTITY_TONE: Record<ActivityEntityType, string> = {
  asset: "bg-pillar-inventory/10 text-pillar-inventory",
  application: "bg-pillar-access/10 text-pillar-access",
  consumable: "bg-pillar-inventory/10 text-pillar-inventory",
  user: "bg-pillar-manage/10 text-pillar-manage",
};

/**
 * The i18n message key (under `shared.activity.line`) for a specific, subject-aware headline, keyed by
 * the activity `action` and the entity pillar. Two variants per access/ownership verb: the full
 * "...to/from {user}" line when the affected user resolved, and a "{subject}"-only line when it didn't
 * (a soft-deleted/unresolved target). The user-pillar lifecycle verbs map to a single subject line (the
 * subject IS the person). `null` → no specific template; the row falls back to the server-built
 * `summary` (issue #311). `restored` is shared by asset-history and user-history, so only the user
 * pillar gets the person line — the asset variant falls through to the generic summary.
 */
function headlineKey(
  action: string,
  hasUser: boolean,
  isUserPillar: boolean,
): string | null {
  switch (action) {
    case "granted":
      return hasUser ? "granted" : "grantedSubject";
    case "revoked":
      return hasUser ? "revoked" : "revokedSubject";
    case "assigned":
      return hasUser ? "assigned" : "assignedSubject";
    case "released":
      return hasUser ? "released" : "releasedSubject";
    case "updated":
      return isUserPillar ? "userUpdated" : null;
    case "role_changed":
      return isUserPillar ? "userRoleChanged" : null;
    case "restored":
      return isUserPillar ? "userRestored" : null;
    case "password_reset_sent":
      return isUserPillar ? "userPasswordResetSent" : null;
    default:
      return null;
  }
}

/**
 * One timeline row — densified for the narrow rail-adjacent column (Wave 3a): a pillar-tinted
 * icon chip with the timeline connector, a single-line (truncating) summary link, and a compact
 * meta line carrying the actor avatar + name, a dot separator and the relative time. Tighter
 * vertical rhythm than the old two-line layout, while keeping the staggered `rise-in` settle.
 *
 * Subject specificity (issue #311): the headline names WHICH entity (and, for access/ownership, WHICH
 * user) the event concerns — "Access to <App> revoked from <User>" — built from the server-resolved
 * `subjectName` / `targetUserName`, falling back to the generic `summary` when the data is missing. The
 * relative time carries the ABSOLUTE date+time as a tooltip + aria-label, and when the event is about a
 * person the meta line adds a click-through chip to that user's detail page.
 */
export function ActivityRow({
  item,
  isLast,
  index,
}: {
  item: RecentActivityItem;
  isLast: boolean;
  /** Global 0-based position in the flattened stream, for the capped staggered settle. */
  index: number;
}) {
  const t = useTranslations("shared");
  const { dateTime, relative } = useFormatters();
  const meta = ENTITY_META[item.entityType];
  const Icon = meta.icon;

  // Build the specific headline when the subject (and, where relevant, the target user) resolved;
  // otherwise fall back to the server-built summary.
  const targetUser = item.targetUserName?.trim() || null;
  const isUserPillar = item.entityType === "user";
  const key = item.subjectName
    ? headlineKey(item.action, Boolean(targetUser), isUserPillar)
    : null;
  const headline =
    key && item.subjectName
      ? t(`activity.line.${key}`, {
          subject: item.subjectName,
          user: targetUser ?? "",
        })
      : item.summary;

  // The affected user gets a SECOND click-through (distinct from the primary entity link) — but only
  // when it isn't already the primary link target (the user pillar links the entity itself).
  const showTargetUserLink =
    item.targetUserId !== null && targetUser !== null && !isUserPillar;

  const absolute = dateTime(item.occurredAt);

  return (
    <li
      className="relative flex animate-rise-in gap-3 pb-3.5 [animation-delay:calc(var(--i)*24ms)] last:pb-0"
      style={{ "--i": Math.min(index, STAGGER_CAP) } as CSSProperties}
    >
      {!isLast && (
        <span
          className="absolute top-7 left-[13px] h-[calc(100%-1.25rem)] w-px bg-border"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg ring-2 ring-background",
          ENTITY_TONE[item.entityType],
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={meta.href(item.entityId)}
          className="block truncate text-sm font-medium outline-none transition-colors hover:text-foreground hover:underline focus-visible:underline"
          title={headline}
        >
          {headline}
        </Link>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.actorName ? (
            <>
              <ActorAvatar name={item.actorName} seed={item.actorId} />
              <span className="min-w-0 truncate">{item.actorName}</span>
            </>
          ) : (
            <span>{t("activity.system")}</span>
          )}
          {showTargetUserLink && (
            <>
              <span aria-hidden>→</span>
              <Link
                href={`/users/${item.targetUserId}`}
                className="min-w-0 truncate rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
                title={t("activity.viewUser", { user: targetUser })}
              >
                {targetUser}
              </Link>
            </>
          )}
          <time
            dateTime={item.occurredAt}
            className="ml-auto shrink-0 cursor-default pl-1 font-mono text-[11px] tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 hover:decoration-muted-foreground"
            title={t("activity.occurredAt", { datetime: absolute })}
            aria-label={t("activity.occurredAt", { datetime: absolute })}
          >
            {relative(item.occurredAt)}
          </time>
        </div>
      </div>
    </li>
  );
}

export function actorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Tiny actor avatar for the feed. The activity row carries only a display name + id (no email), so
 * initials come from the name and the color is seeded by the actor id (stable per person), falling
 * back to the name when the id is null. Uses the canonical {@link avatarColorFor} palette so the
 * same identity gets the same color here as on Users, asset owners and access grantees.
 */
export function ActorAvatar({
  name,
  seed,
}: {
  name: string;
  seed: string | null;
}) {
  return (
    <Avatar size="sm" title={name}>
      <AvatarFallback className={cn("font-medium", avatarColorFor(seed ?? name))}>
        {actorInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
