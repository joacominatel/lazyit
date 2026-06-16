"use client";

import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * Known top-level route segments with a translated label under the
 * `shared.chrome.breadcrumb` namespace. Anything not listed falls back to a
 * title-cased version of the raw segment (and dynamic id/slug segments are
 * dropped — see `buildItems`). This is the one place the route→label map lives,
 * replacing the per-page "Back to X" ghost buttons.
 */
const KNOWN_SEGMENTS = [
  "dashboard",
  "assets",
  "consumables",
  "applications",
  "kb",
  "reports",
  "users",
  "locations",
  "new",
  "edit",
] as const;
const KNOWN_SEGMENT_SET = new Set<string>(KNOWN_SEGMENTS);

export interface BreadcrumbItem {
  label: string;
  /** Omitted on the last (current) crumb, which renders as plain text. */
  href?: string;
}

interface BreadcrumbProps {
  /**
   * Explicit crumbs. When omitted, the trail is derived from the current path
   * via `usePathname()`. Pass this from a detail page once it knows the record's
   * real name (e.g. the asset name instead of its cuid).
   */
  items?: BreadcrumbItem[];
  /**
   * Raw, non-label segments to drop when deriving from the path — typically the
   * dynamic id/slug between a list and its `edit`. Defaults to common id shapes.
   */
  hideSegments?: (segment: string, index: number, segments: string[]) => boolean;
  className?: string;
}

/** Title-case an unknown segment: "asset-models" → "Asset Models". */
function humanize(segment: string): string {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Heuristic: dynamic route params (cuid/uuid/slug) aren't meaningful crumbs. */
function looksDynamic(segment: string): boolean {
  // cuid (starts c, ~25 chars), uuid (has dashes + hex), or a long opaque token.
  return (
    /^c[a-z0-9]{20,}$/i.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ||
    segment.length > 20
  );
}

/**
 * Route-driven breadcrumb. Renders an ordered trail from the current path, with
 * human labels for known segments. The current page is the non-linked tail.
 *
 * Single-segment paths (e.g. `/dashboard`) render nothing — there's no trail to
 * show. Dynamic id/slug segments are dropped by default so a detail URL collapses
 * to its list crumb; pass explicit `items` to surface the record's real name.
 */
export function Breadcrumb({ items, hideSegments, className }: BreadcrumbProps) {
  const t = useTranslations("shared");
  const pathname = usePathname();

  const trail = useMemo<BreadcrumbItem[]>(() => {
    if (items) return items;

    const segments = pathname.split("/").filter(Boolean);
    const shouldHide =
      hideSegments ?? ((segment) => looksDynamic(segment));

    const crumbs: BreadcrumbItem[] = [];
    let hrefAcc = "";
    segments.forEach((segment, index) => {
      hrefAcc += `/${segment}`;
      if (shouldHide(segment, index, segments)) return;
      crumbs.push({
        label: KNOWN_SEGMENT_SET.has(segment)
          ? t(`chrome.breadcrumb.${segment}`)
          : humanize(segment),
        href: hrefAcc,
      });
    });

    // The last crumb is the current page: drop its link.
    if (crumbs.length > 0) {
      crumbs[crumbs.length - 1] = { label: crumbs[crumbs.length - 1].label };
    }
    return crumbs;
  }, [items, pathname, hideSegments, t]);

  // Nothing useful to show for a top-level page.
  if (trail.length < 2) return null;

  return (
    <nav aria-label={t("chrome.breadcrumbLabel")} className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? (
                <li aria-hidden="true" className="text-muted-foreground/50">
                  <ChevronRightIcon className="size-3.5" />
                </li>
              ) : null}
              <li>
                {isLast || !crumb.href ? (
                  <span
                    aria-current="page"
                    className="font-medium text-foreground"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    href={crumb.href}
                    className={cn(
                      "rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
