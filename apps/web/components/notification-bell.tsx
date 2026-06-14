"use client";

import {
  BellIcon,
  BoltIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { Notification, NotificationType } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, type ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from "@/lib/api/hooks/use-notifications";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelativeTime } from "@/lib/utils/format";

/**
 * The topbar notification bell (ADR-0056 §8, amended #453) — rendered for EVERY authenticated human
 * (the `(app)` shell already requires auth, so this component just always renders). It does NOT self-gate
 * on `notification:read`: the API is the real gate and scopes the feed per caller, so a non-admin sees
 * only their own targeted rows (e.g. the `secret.vault_setup` nudge), while a `notification:read` holder
 * also sees the broadcast set. It POLLS the unread count for the badge and, while open, the most recent
 * page for the dropdown. Each row reuses the dashboard recent-activity visual grammar (a pillar-tinted
 * icon chip + a single-line title + relative time) so the bell reads as one visual family with the rest
 * of the app — but it is backed by the `Notification` store, not the `recent_activity` view. A row click
 * marks it read and deep-links to its target; "Mark all read" clears the badge.
 *
 * When SSE lands (Phase 2) the same hooks push live behind the same endpoints — this component does not
 * change shape.
 */

/** Per-type icon + the pillar tone (matching activity-row's chip grammar) and the deep-link builder. */
const TYPE_META: Record<
  NotificationType,
  {
    icon: ComponentType<{ className?: string }>;
    tone: string;
    href: (n: Notification) => string;
  }
> = {
  critical_app_access: {
    icon: KeyIcon,
    tone: "bg-pillar-access/10 text-pillar-access",
    href: (n) => (n.entityId ? `/applications/${n.entityId}` : "/applications"),
  },
  admin_granted: {
    icon: ShieldCheckIcon,
    tone: "bg-pillar-access/10 text-pillar-access",
    href: (n) => (n.entityId ? `/applications/${n.entityId}` : "/applications"),
  },
  low_stock: {
    icon: CubeIcon,
    tone: "bg-pillar-inventory/10 text-pillar-inventory",
    href: (n) => (n.entityId ? `/consumables/${n.entityId}` : "/consumables"),
  },
  // Both workflow types deep-link to the manual-task inbox (ADR-0056 §8) — the engine's nudge surface.
  // The engine lives under Settings → Integrations, so its rows use the `manage` pillar tone.
  "workflow.manual_task": {
    icon: BoltIcon,
    tone: "bg-pillar-manage/10 text-pillar-manage",
    href: () => "/settings/integrations/tasks",
  },
  "workflow.run_failed": {
    icon: ExclamationTriangleIcon,
    tone: "bg-destructive/10 text-destructive",
    href: () => "/settings/integrations/tasks",
  },
  // The login-time vault-setup nudge (ADR-0056 amendment, #453) — a TARGETED per-user notification
  // prompting a `secret:read` holder with no keypair to set up their vault passphrase. Deep-links to the
  // Secret Manager bootstrap. (The richer bell/banner UX is the frontend follow-up; this entry keeps the
  // closed-enum map exhaustive so the type is renderable.)
  "secret.vault_setup": {
    icon: KeyIcon,
    tone: "bg-pillar-access/10 text-pillar-access",
    href: () => "/secrets",
  },
};

/** Fallback meta for an unknown future type (defensive — the closed enum should make this unreachable). */
const FALLBACK_META = {
  icon: UserPlusIcon,
  tone: "bg-muted text-muted-foreground",
  href: () => "/dashboard",
} as const;

function metaFor(type: NotificationType) {
  return TYPE_META[type] ?? FALLBACK_META;
}

export function NotificationBell() {
  const t = useTranslations("notifications");
  const [open, setOpen] = useState(false);
  // Snapshot "now" once so relative times stay pure across renders (react-hooks/purity) — the same
  // pattern as the dashboard recent-activity panel.
  const [now] = useState(() => Date.now());

  // The badge always polls (a cheap COUNT, per-caller scoped server-side); the heavier list polls only
  // while the dropdown is open. No permission pre-check — the bell shows for every authenticated human
  // and the API scopes visibility (a non-admin sees only their own targeted rows). A user with zero
  // notifications simply sees a clean bell: the badge renders only when `unread > 0`.
  const { data: count } = useUnreadNotificationCount(true);
  const { data: page, isLoading } = useNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unread = count?.unread ?? 0;
  const items = page?.items ?? [];
  const hasUnread = unread > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ariaLabel", { count: unread })}
          className="relative"
        >
          <BellIcon className="size-5" />
          {hasUnread && (
            <Badge
              variant="destructive"
              className="absolute -right-0.5 -top-0.5 size-4 min-w-4 rounded-full px-1 tabular-nums"
              aria-hidden
            >
              {unread > 99 ? "99+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-sm font-medium">{t("title")}</p>
          {hasUnread && (
            <button
              type="button"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="rounded-sm text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:underline disabled:opacity-50"
            >
              {t("markAllRead")}
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto overscroll-contain">
          {isLoading ? (
            <NotificationSkeleton />
          ) : items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => (
                <NotificationListItem
                  key={n.id}
                  notification={n}
                  now={now}
                  onActivate={() => {
                    if (!n.read) markRead.mutate(n.id);
                    setOpen(false);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One bell row — the activity-row grammar adapted: a type-tinted icon chip, a single-line title, an
 * optional one-line summary, the relative time, and an unread dot. The whole row is a deep-link that
 * marks the notification read on activation. All text is server-built + escaped (INV-6 / SEC-A5).
 */
function NotificationListItem({
  notification: n,
  now,
  onActivate,
}: {
  notification: Notification;
  now: number;
  onActivate: () => void;
}) {
  const t = useTranslations("notifications");
  const meta = metaFor(n.type);
  const Icon = meta.icon;
  const absolute = formatDateTime(n.createdAt);

  return (
    <li className={cn("relative", !n.read && "bg-primary/[0.03]")}>
      <Link
        href={meta.href(n)}
        onClick={onActivate}
        className="flex gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            meta.tone,
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-sm",
              n.read ? "font-normal text-foreground/90" : "font-medium",
            )}
            title={n.title}
          >
            {n.title}
          </p>
          {n.summary && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n.summary}>
              {n.summary}
            </p>
          )}
          <time
            dateTime={n.createdAt}
            className="mt-1 block text-xs tabular-nums text-muted-foreground"
            title={t("occurredAt", { datetime: absolute })}
          >
            {formatRelativeTime(n.createdAt, now)}
          </time>
        </div>
        {!n.read && (
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
            aria-label={t("unreadDot")}
          />
        )}
      </Link>
    </li>
  );
}

const SKELETON_KEYS = ["a", "b", "c"] as const;

function NotificationSkeleton() {
  return (
    <ul className="divide-y divide-border">
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="flex gap-3 px-4 py-3">
          <Skeleton className="size-7 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}
