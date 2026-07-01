"use client";

import {
  BookOpenIcon,
  CpuChipIcon,
  CubeIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  TagIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { ArrowUpRightIcon } from "@heroicons/react/16/solid";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useRef } from "react";
import { AssetStatusBadge } from "@/app/(app)/assets/_components/asset-status-badge";
import { ArticleStatusBadge } from "@/app/(app)/kb/_components/article-status-badge";
import { LocationTypeBadge } from "@/app/(app)/locations/_components/location-type-badge";
import { UserRoleBadge } from "@/app/(app)/users/_components/user-role-badge";
import { UserStatusBadge } from "@/app/(app)/users/_components/user-status-badge";
import { DetailField } from "@/components/detail-panel";
import {
  detailHref,
  FULL_WIDTH_FIELDS,
  type QuickViewData,
  selectFields,
  titleFor,
} from "@/components/quick-view-fields";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import { statusTone } from "@/lib/infra/canvas";
import { cn } from "@/lib/utils";

export type {
  QuickViewData,
  QuickViewEntity,
} from "@/components/quick-view-fields";

/**
 * Quick View (epic #788, wave 1) — a generous, entity-aware preview popover surfaced by the eye
 * affordance in the entity pickers ({@link Combobox} + its 6 wrappers). It lets a user disambiguate
 * terse labels (a serial, a slug, "Juan D.") **without leaving the flow**.
 *
 * Built on the existing radix {@link Popover} (NOT HoverCard/Tooltip — those aren't vendored and
 * can't do the click-to-pin / keyboard story this needs, ADR-0072). It is fully controlled: the
 * caller (the Combobox row) owns `open` + `pinned` so it can guarantee a single Quick View open at a
 * time and return focus on Escape. The eye `<button>` is passed in as {@link QuickViewPopoverProps.anchor}
 * and becomes the radix `PopoverAnchor` so the panel positions off the row, never stealing the
 * button's own focus/role.
 *
 * Data is the row the picker ALREADY loaded (ADR-0072 zero-extra-fetch): the wrappers stop discarding
 * the fields they currently map away and hand the whole entity row to {@link selectFields}. No new
 * fetch, no new endpoint, no widened payload.
 *
 * Three zones: an identity row (entity glyph or {@link UserAvatar} + title + status/role badge),
 * a {@link Separator}, then a `<dl>` field grid of {@link DetailField}s. A pinned-only footer deep-links
 * to the entity detail route in a new tab. Secrets never appear (INV-10); an Application `url` is plain
 * text gated by `isSafeApplicationUrl` (SEC-008, in the presenter). Motion reuses the Popover's
 * enter/exit anims (~100ms, under the ADR-0049 220ms budget; the global `prefers-reduced-motion`
 * guard collapses them).
 */

/** A superset of the global-search `SearchEntity`, so Quick View keeps its own glyph map rather than
 *  reusing the search-scoped `ENTITY_ICON` (ADR-0072: sharing it isn't cleaner — different key sets). */
const ENTITY_GLYPH = {
  asset: ServerStackIcon,
  user: UsersIcon,
  assetModel: CpuChipIcon,
  application: KeyIcon,
  location: MapPinIcon,
  article: BookOpenIcon,
  consumable: CubeIcon,
  category: TagIcon,
  infra: CpuChipIcon,
  serviceAccount: CpuChipIcon,
} as const;

export interface QuickViewPopoverProps {
  /** Controlled open state (owned by the Combobox row so only one is open at a time). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pinned = footer deep-link shown + dialog semantics (a transient hover preview stays role-less). */
  pinned: boolean;
  /** The entity row to render (already loaded by the picker — zero extra fetch). */
  view: QuickViewData;
  /** The trigger element (the eye `<button>`) — becomes the radix `PopoverAnchor` so the panel
   *  positions off the row without stealing the button's focus/role. */
  anchor: ReactNode;
}

export function QuickViewPopover({
  open,
  onOpenChange,
  pinned,
  view,
  anchor,
}: QuickViewPopoverProps) {
  const t = useTranslations("common.quickView");
  const tf = useTranslations("common.quickView.fields");
  // The infra `kind` field is localized from the `infra` namespace (shared with the topology panel).
  const ti = useTranslations("infra");
  const title = titleFor(view);
  // The asset OWNER field needs localized strings the pure presenter can't produce itself; the infra
  // KIND field likewise needs the `infra.kind.*` translator threaded in (presenter stays translator-free).
  const fields = selectFields(view, {
    noOwner: t("noOwner"),
    moreOwners: (count) => t("moreOwners", { count }),
    infraKind: (kind) => ti(`kind.${kind}`),
  });
  const href = detailHref(view);
  const Glyph = ENTITY_GLYPH[view.entity];
  // A stable id for aria-labelledby on the pinned (dialog) panel.
  const titleId = `quick-view-title-${view.data.id}`;

  // There is a PopoverAnchor (the eye) but no PopoverTrigger, so radix has nothing to restore focus to
  // on close and would drop it to <body>. A pinned panel pulls focus IN (dialog semantics), so we
  // capture whatever held focus just before opening — the cmdk search input for the Alt+Enter chord
  // (#793), the eye for a click — and return focus there on close so keyboard nav continues. A transient
  // hover preview never takes focus (`onOpenAutoFocus` prevented), so there is nothing to restore.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        // Above the parent picker's own popover (z-50) so it never tucks behind the list.
        className="z-[60] w-80 p-0"
        // A pinned panel is an explicit dialog the user opened; a transient hover preview is a passive
        // surface, so only the pinned state takes dialog semantics + the labelled title.
        role={pinned ? "dialog" : undefined}
        aria-labelledby={pinned ? titleId : undefined}
        aria-label={pinned ? undefined : t("trigger", { name: title })}
        // Don't yank focus into a transient hover preview (it would fight the cmdk roving focus);
        // a pinned panel is fine to focus.
        onOpenAutoFocus={(event) => {
          if (!pinned) {
            event.preventDefault();
            returnFocusRef.current = null;
          } else {
            // Capture the roving-focus owner (the cmdk input for the Alt+Enter chord) BEFORE radix
            // pulls focus into the pinned panel, so we can restore it on close.
            const active = document.activeElement;
            returnFocusRef.current =
              active instanceof HTMLElement ? active : null;
          }
        }}
        // Radix would focus a (nonexistent) trigger and otherwise drop focus to <body>; restore the
        // captured owner ourselves so Escape on a keyboard-opened preview returns focus to the input.
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          if (target && target.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {/* Zone 1 — identity row. */}
        <div className="flex items-start gap-2.5 p-3">
          {view.entity === "user" ? (
            <UserAvatar
              firstName={view.data.firstName}
              lastName={view.data.lastName}
              email={view.data.email}
              size="sm"
            />
          ) : (
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Glyph className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <h3
              id={titleId}
              className="text-sm leading-snug font-semibold break-words"
            >
              {title}
            </h3>
            <IdentityBadge view={view} />
          </div>
        </div>

        {/* Zone 2 + 3 — the field grid (only when there's at least one present field). */}
        {fields.length > 0 ? (
          <>
            <Separator />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-3">
              {fields.map((field) => (
                <DetailField
                  key={field.labelKey}
                  label={tf(field.labelKey)}
                  className={cn(
                    FULL_WIDTH_FIELDS.has(field.labelKey) && "col-span-2",
                  )}
                >
                  <span
                    className={cn(
                      "break-words",
                      field.mono && "font-mono text-[0.8125rem]",
                    )}
                  >
                    {field.value}
                  </span>
                </DetailField>
              ))}
            </dl>
          </>
        ) : null}

        {/* Pinned-only footer: deep-link to the full record (new tab), when a detail route exists. */}
        {pinned && href ? (
          <>
            <Separator />
            <div className="p-2">
              <Link
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-primary transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {t("openRecord")}
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The status/role badge in the identity row, per entity. Returns nothing for entities with no badge
 *  (asset model, category, consumable) so the row collapses cleanly. */
function IdentityBadge({ view }: { view: QuickViewData }) {
  // Called unconditionally (hook rules); the infra + service-account cases read these.
  const ti = useTranslations("infra");
  const tq = useTranslations("common.quickView");
  switch (view.entity) {
    case "asset":
      return <AssetStatusBadge status={view.data.status} />;
    case "user":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <UserStatusBadge isActive={view.data.isActive} />
          <UserRoleBadge role={view.data.role} />
        </span>
      );
    case "location":
      return <LocationTypeBadge type={view.data.type} />;
    case "article":
      return <ArticleStatusBadge status={view.data.status} />;
    case "infra":
      // Mirror the topology panel: a toned status dot-badge (online/offline/unknown), localized from
      // the same `infra.status.*` keys.
      return (
        <StatusBadge tone={statusTone(view.data.status)} dot>
          {ti(`status.${view.data.status}`)}
        </StatusBadge>
      );
    case "serviceAccount":
      // A machine member (#888): active (token authenticates) vs. inactive (soft-disabled). Neutral tone
      // for the paused state mirrors the Service accounts admin surface.
      return (
        <StatusBadge tone={view.data.isActive ? "success" : "neutral"} dot>
          {tq(view.data.isActive ? "saActive" : "saInactive")}
        </StatusBadge>
      );
    default:
      return null;
  }
}
