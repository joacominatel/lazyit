"use client";

import { PencilIcon } from "@heroicons/react/24/outline";
import { type AccessGrant, type User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Pagination } from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { GrantRunChip } from "../workflows/_components/grant-run-chip";

const PAGE_SIZE = 25;

export interface GroupedAccessListProps {
  activeGrants: AccessGrant[];
  userById: Map<string, User>;
  /** Stable snapshot of "now" from the page for expiry comparisons. */
  now: number;
  applicationId: string;
  canGrant: boolean;
  canReadWorkflows: boolean;
  /** Called when the user clicks Edit on a grant. */
  onEdit: (grant: AccessGrant) => void;
  /** Called when the user clicks Revoke on a grant. */
  onRevoke: (grant: AccessGrant) => void;
  userName: (userId: string) => string;
}

interface GrantGroup {
  userId: string;
  grants: AccessGrant[];
}

export function GroupedAccessList({
  activeGrants,
  userById,
  now,
  applicationId,
  canGrant,
  canReadWorkflows,
  onEdit,
  onRevoke,
  userName,
}: GroupedAccessListProps) {
  const t = useTranslations("applications");
  const { date } = useFormatters();

  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  // Group active grants by userId, preserving insertion order within each group.
  // Sort groups alphabetically by resolved user name.
  const allGroups = useMemo<GrantGroup[]>(() => {
    const map = new Map<string, AccessGrant[]>();
    for (const grant of activeGrants) {
      const existing = map.get(grant.userId) ?? [];
      map.set(grant.userId, [...existing, grant]);
    }
    return [...map.entries()]
      .map(([userId, grants]) => ({ userId, grants }))
      .sort((a, b) =>
        userName(a.userId).localeCompare(userName(b.userId)),
      );
  }, [activeGrants, userName]);

  // Client-side search over resolved user names.
  const filteredGroups = useMemo<GrantGroup[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((group) =>
      userName(group.userId).toLowerCase().includes(q),
    );
  }, [allGroups, search, userName]);

  // Reset offset when search changes so results always start from page 1.
  function handleSearch(value: string) {
    setSearch(value);
    setOffset(0);
  }

  const total = filteredGroups.length;
  const page = filteredGroups.slice(offset, offset + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <SearchInput
        value={search}
        onChange={handleSearch}
        label={t("detail.accessSearchLabel")}
        placeholder={t("detail.accessSearchPlaceholder")}
      />

      {page.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim()
            ? t("detail.accessSearchEmpty")
            : t("detail.noActiveGrants")}
        </p>
      ) : (
        <ul className="divide-y">
          {page.map((group) => {
            const user = userById.get(group.userId);
            const gone = user?.deletedAt != null;

            return (
              <li key={group.userId} className="py-3 first:pt-0 last:pb-0">
                {/* Group header row — user identity + multi-grant count badge */}
                <div className="flex items-center gap-3">
                  {user ? (
                    <UserAvatar
                      firstName={user.firstName}
                      lastName={user.lastName}
                      email={user.email}
                      className={gone ? "opacity-50 grayscale" : undefined}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {user ? (
                        <Link
                          href={`/users/${user.id}`}
                          className="truncate font-medium hover:underline"
                        >
                          {userName(group.userId)}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">
                          {userName(group.userId)}
                        </span>
                      )}
                      {gone && (
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          {t("detail.deactivatedBadge")}
                        </Badge>
                      )}
                      {group.grants.length > 1 && (
                        <Badge variant="secondary">
                          {t("detail.grantCount", {
                            count: group.grants.length,
                          })}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                {/* Individual grants — always fully expanded so each is independently revokable/editable */}
                <ul className="mt-2 space-y-2 pl-11">
                  {group.grants.map((grant) => {
                    const expired =
                      grant.expiresAt != null &&
                      new Date(grant.expiresAt).getTime() < now;
                    return (
                      <li
                        key={grant.id}
                        className="flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {grant.accessLevel && (
                              <Badge variant="secondary">
                                {grant.accessLevel}
                              </Badge>
                            )}
                            {expired && (
                              <StatusBadge tone="warning">
                                {t("detail.expiredBadge")}
                              </StatusBadge>
                            )}
                            {canReadWorkflows && (
                              <GrantRunChip
                                applicationId={applicationId}
                                accessGrantId={grant.id}
                              />
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-sm text-muted-foreground">
                            {t("detail.grantedLine", {
                              date: date(grant.grantedAt),
                            })}
                            {grant.grantedById
                              ? t("detail.grantedByPart", {
                                  name: userName(grant.grantedById),
                                })
                              : ""}
                            {grant.expiresAt
                              ? t("detail.expiresPart", {
                                  date: date(grant.expiresAt),
                                })
                              : ""}
                            {grant.notes
                              ? t("detail.notesPart", { notes: grant.notes })
                              : ""}
                          </p>
                        </div>
                        {canGrant && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("detail.editGrantAriaLabel")}
                              onClick={() => onEdit(grant)}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onRevoke(grant)}
                            >
                              {t("detail.revoke")}
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        itemCount={page.length}
        onOffsetChange={setOffset}
      />
    </div>
  );
}
