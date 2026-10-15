"use client";

import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useUserList } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";

/** How many of the newest directory persons to preview in the tray (the rest live under the Users link). */
const PREVIEW_LIMIT = 8;

// Read-only preview of the newest login-less directory persons (ADR-0091); the Users list is the queue.
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

  // A plain section, not a warning callout (#1533): new arrivals are routine, not a risk.
  return (
    <SettingsSection
      title={t("title")}
      summary={t("summary")}
      help={<p>{t("description")}</p>}
      status={<Badge variant="secondary">{total}</Badge>}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/users?directory=directory">
            {t("viewAll")}
            <ArrowRightIcon />
          </Link>
        </Button>
      }
    >
      <ul className="-my-2 divide-y">
        {people.map((person) => (
          <li
            key={person.id}
            className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between"
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
    </SettingsSection>
  );
}
