"use client";

import {
  ArrowRightIcon,
  InboxArrowDownIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useUserList } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";

/** How many of the newest directory persons to preview in the tray (the rest live under the Users link). */
const PREVIEW_LIMIT = 8;

/**
 * The PENDING review tray for AD/LDAP-discovered persons (issue #839, ADR-0091). The directory sync creates
 * LOGIN-LESS `directoryOnly` VIEWER persons (no Zitadel mirror, no password) — the same `directoryOnly`
 * rows the bulk import creates — so there is NO new entity or confirm/discard endpoint: the review surface
 * IS the existing Users list, and this tray is the at-a-glance preview of the newest arrivals right where
 * the sync is configured (`GET /users?directoryOnly=true`, ADR-0069 §0 #2). Each person is a real User that
 * an operator can open, edit, provision a login for, or offboard from the Users section — this tray just
 * surfaces them and links through.
 *
 * ponytail: read-only preview + deep-link, NOT a bespoke approve/reject queue — the persons already exist
 * as Users; reusing the Users list (its own search/sort/paging, the shared "Directory" badge) is the whole
 * feature. Renders nothing while loading, when the caller can't read users, or when none exist — no empty
 * tray noise.
 */
export function DirectoryPendingTray() {
  const t = useTranslations("settings.directory.tray");
  const { relative } = useFormatters();
  const canReadUsers = useCan("user:read");

  // Newest directory persons first — the same server slice the Users list "Directory" filter uses.
  const { data, isLoading } = useUserList({
    directoryOnly: true,
    sort: "createdAt",
    dir: "desc",
    limit: PREVIEW_LIMIT,
  });

  const people = data?.items ?? [];
  const total = data?.total ?? 0;
  if (!canReadUsers || isLoading || people.length === 0) return null;

  return (
    <section
      className="mt-6 space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-4"
      aria-label={t("title")}
    >
      <div className="flex items-start gap-2">
        <InboxArrowDownIcon
          className="mt-0.5 size-5 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{t("title")}</h3>
            <Badge variant="secondary">{total}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <ul className="divide-y rounded-md border bg-card">
        {people.map((person) => (
          <li
            key={person.id}
            className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/users/${person.id}`}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {person.firstName} {person.lastName}
                </Link>
                {!person.isActive ? (
                  <StatusBadge tone="neutral">{t("offboarded")}</StatusBadge>
                ) : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {person.email}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("discovered", { when: relative(person.createdAt) })}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex justify-end">
        <Button asChild variant="outline" size="sm">
          <Link href="/users?directory=directory">
            {t("viewAll")}
            <ArrowRightIcon />
          </Link>
        </Button>
      </div>
    </section>
  );
}
