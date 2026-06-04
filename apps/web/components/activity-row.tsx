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
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format";

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
 * One timeline row — densified for the narrow rail-adjacent column (Wave 3a): a pillar-tinted
 * icon chip with the timeline connector, a single-line (truncating) summary link, and a compact
 * meta line carrying the actor avatar + name, a dot separator and the relative time. Tighter
 * vertical rhythm than the old two-line layout, while keeping the staggered `rise-in` settle.
 */
export function ActivityRow({
  item,
  isLast,
  index,
  now,
}: {
  item: RecentActivityItem;
  isLast: boolean;
  /** Global 0-based position in the flattened stream, for the capped staggered settle. */
  index: number;
  now: number;
}) {
  const t = useTranslations("shared");
  const meta = ENTITY_META[item.entityType];
  const Icon = meta.icon;
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
          className="block truncate text-sm font-medium outline-none hover:underline focus-visible:underline"
          title={item.summary}
        >
          {item.summary}
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
          <span
            className="ml-auto shrink-0 pl-1 tabular-nums"
            title={new Date(item.occurredAt).toLocaleString()}
          >
            {formatRelativeTime(item.occurredAt, now)}
          </span>
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
