"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type {
  AssetHistory,
  AssetHistoryEventType,
  User,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import { useAssetHistory } from "@/lib/api/hooks/use-asset-history";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";

/** Maps each event type to its label key under `assets.detail.timeline.events`. */
const EVENT_LABEL_KEY: Record<AssetHistoryEventType, string> = {
  CREATED: "created",
  STATUS_CHANGED: "statusChanged",
  ASSIGNED: "assigned",
  RELEASED: "released",
  LOCATION_CHANGED: "locationChanged",
  MODEL_CHANGED: "modelChanged",
  SPECS_CHANGED: "specsChanged",
  DELETED: "deleted",
  RESTORED: "restored",
};

/**
 * Event badge appearance (ADR-0049). These badges carry READABLE TEXT (the event label),
 * so a chart/pillar hue as the text color would FAIL WCAG-AA on the bone canvas. Two safe
 * shapes only:
 *  - "status": a semantic event maps to a solid-fill StatusBadge tone, whose label sits on
 *    the token's AA-verified *-foreground (light 4.69–8.58:1 · dark 7.16–10.99:1).
 *  - "categorical": a non-status event gets a NEUTRAL pill (bg-secondary, AA-verified
 *    foreground) with a small chart-hue dot — colour rides the decorative dot while the
 *    label text stays on --secondary-foreground, so contrast holds in both themes.
 * Full strings so the Tailwind scanner keeps the dot colours.
 */
type EventBadgeSpec =
  | { kind: "status"; tone: StatusTone }
  | { kind: "categorical"; dot: string };

const EVENT_BADGE: Record<AssetHistoryEventType, EventBadgeSpec> = {
  // Semantic — solid StatusBadge tone (label on the tone's AA-verified foreground).
  CREATED: { kind: "status", tone: "success" },
  RESTORED: { kind: "status", tone: "success" },
  RELEASED: { kind: "status", tone: "warning" },
  STATUS_CHANGED: { kind: "status", tone: "info" },
  DELETED: { kind: "status", tone: "danger" },
  // Categorical — neutral pill + a chart-hue dot (label stays on --foreground).
  ASSIGNED: { kind: "categorical", dot: "bg-chart-1" },
  LOCATION_CHANGED: { kind: "categorical", dot: "bg-chart-2" },
  MODEL_CHANGED: { kind: "categorical", dot: "bg-chart-3" },
  SPECS_CHANGED: { kind: "categorical", dot: "bg-muted-foreground" },
};

/** The rail tick colour (ADR-0077): a semantic event lights its tick with its status tone;
 *  categorical events keep a neutral tick, so the ledger margin only colours up for real state
 *  changes. Decorative (the badge already carries the meaning). */
const TICK_TONE: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
};

function tickClass(eventType: AssetHistoryEventType): string {
  const badge = EVENT_BADGE[eventType];
  return badge.kind === "status" ? TICK_TONE[badge.tone] : "bg-border";
}

/** Renders the event label as either a solid status mark or a neutral ledger-tag with a hue dot. */
function EventBadge({ eventType }: { eventType: AssetHistoryEventType }) {
  const t = useTranslations("assets.detail.timeline.events");
  const badge = EVENT_BADGE[eventType];
  const label = t(EVENT_LABEL_KEY[eventType]);
  if (badge.kind === "status") {
    return <StatusBadge tone={badge.tone}>{label}</StatusBadge>;
  }
  // Categorical events get a neutral ledger-tag matching the StatusMark geometry (rounded-sm,
  // uppercase, inset ring) with a small hue dot carrying the category colour — the AA-safe shape
  // (label on --secondary-foreground, colour rides the decorative dot; ADR-0049 §4 / ADR-0077).
  return (
    <span className="inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] font-medium tracking-[0.04em] uppercase whitespace-nowrap text-secondary-foreground ring-1 ring-inset ring-foreground/10">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", badge.dot)}
        aria-hidden
      />
      {label}
    </span>
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The AssetHistory event log (ADR-0033) as a vertical timeline. Reads its own paginated history
 * (cursor on id) plus the users list to resolve actors and the `{userId}` payloads of
 * ASSIGNED/RELEASED. Self-contained — the detail page just drops it into a panel.
 */
export function AssetHistoryTimeline({ assetId }: { assetId: string }) {
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useAssetHistory(assetId);
  const { data: users } = useUsers();
  const t = useTranslations("assets.detail.timeline");
  const tc = useTranslations("common");
  const { dateTime, relative } = useFormatters();

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((user) => [user.id, user])),
    [users],
  );
  const events = useMemo(() => (data?.pages ?? []).flat(), [data]);

  function userName(id: string | undefined): string {
    if (!id) return t("someone");
    const user = userById.get(id);
    return user ? `${user.firstName} ${user.lastName}` : t("aUser");
  }

  /** Contextual detail for an event (the type itself is shown as a badge). */
  function detail(event: AssetHistory): string | null {
    const payload = event.payload ?? {};
    switch (event.eventType) {
      case "STATUS_CHANGED": {
        const from = asString(payload.from);
        const to = asString(payload.to);
        return from && to ? t("statusChange", { from, to }) : null;
      }
      case "ASSIGNED":
        return t("assignedTo", { name: userName(asString(payload.userId)) });
      case "RELEASED":
        return t("releasedFrom", { name: userName(asString(payload.userId)) });
      case "CREATED":
        return t("details.created");
      case "LOCATION_CHANGED":
        return t("details.locationChanged");
      case "MODEL_CHANGED":
        return t("details.modelChanged");
      case "SPECS_CHANGED":
        return t("details.specsChanged");
      case "DELETED":
        return t("details.deleted");
      case "RESTORED":
        return t("details.restored");
      default:
        return null;
    }
  }

  if (isLoading) {
    return (
      <ul className="space-y-4">
        {["a", "b", "c"].map((key) => (
          <li key={key} className="flex gap-3">
            <Skeleton className="mt-1 size-2.5 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">{t("loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <ArrowPathIcon />
          {tc("retry")}
        </Button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("empty")}</p>
    );
  }

  return (
    <div className="space-y-4">
      <ol>
        {events.map((event, index) => {
          const actor = event.performedById
            ? userById.get(event.performedById)
            : undefined;
          const text = detail(event);
          const isLast = index === events.length - 1;
          return (
            <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast && (
                <span
                  className="absolute top-3 left-[5px] h-full w-px bg-border"
                  aria-hidden
                />
              )}
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-[2px] ring-2 ring-background",
                  tickClass(event.eventType),
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <EventBadge eventType={event.eventType} />
                  {text && <span className="text-sm">{text}</span>}
                  <span
                    className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                    title={dateTime(event.createdAt)}
                  >
                    {relative(event.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {actor ? (
                    <>
                      <UserAvatar
                        size="sm"
                        firstName={actor.firstName}
                        lastName={actor.lastName}
                        email={actor.email}
                      />
                      <span>
                        {actor.firstName} {actor.lastName}
                      </span>
                    </>
                  ) : (
                    <span>{t("system")}</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage && <ArrowPathIcon className="animate-spin" />}
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}
