"use client";

import {
  EllipsisHorizontalIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  UserPlusIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type {
  AccessGrant,
  AccessGrantListPage,
  ApplicationGrantStatus,
  ApplicationGrantSummary,
  UserListItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { ExportButton } from "@/components/export-button";
import { ErrorState, Pagination } from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import {
  applicationGrantPageFilterParams,
  applicationGrantsExportPath,
} from "@/lib/api/endpoints/applications";
import {
  ANY_ACCESS_LEVEL,
  GRANT_STATUS_FILTERS,
  grantLevelSelection,
  isGrantListNarrowed,
  MAX_GRANT_QUERY_LENGTH,
  NO_ACCESS_LEVEL,
} from "@/lib/applications/grant-list-query";
import { accessLevelOptions, showAccessLevelPicker } from "@/lib/applications/grant-view";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { expiryState, GRANT_EXPIRING_WITHIN_DAYS } from "@/lib/record/record-state";
import { cn } from "@/lib/utils";
import { GrantRunChip } from "../workflows/_components/grant-run-chip";
import type { GrantListParams } from "./use-grant-list-params";

const ROW_GRID =
  "@2xl:grid @2xl:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_7rem_8.5rem_2.25rem] @2xl:items-center";

export interface ApplicationAccessTabProps {
  applicationId: string;
  /** The current page of grants, filtered and ordered by the server (#1660); `undefined` while loading. */
  page: AccessGrantListPage | undefined;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  /** Counts and levels over every grant of the application; `undefined` while loading or on error. */
  summary: ApplicationGrantSummary | undefined;
  /** The tab's URL state: status, level, search and page. */
  list: GrantListParams;
  /** `user:read`: the person search is shown (and sent) only then, the API answers 403 otherwise. */
  canSearchPeople: boolean;
  userById: ReadonlyMap<string, UserListItem>;
  now: number;
  canGrant: boolean;
  canReadWorkflows: boolean;
  onGrant: () => void;
  onEdit: (grant: AccessGrant) => void;
  onRevoke: (grant: AccessGrant) => void;
}

export function ApplicationAccessTab({
  applicationId,
  page,
  isFetching,
  isError,
  error,
  onRetry,
  summary,
  list,
  canSearchPeople,
  userById,
  now,
  canGrant,
  canReadWorkflows,
  onGrant,
  onEdit,
  onRevoke,
}: ApplicationAccessTabProps) {
  const t = useTranslations("applications.detail.access");
  const { params } = list;
  const status = params.status;
  const levelSelection = grantLevelSelection(params);
  const levels = useMemo(() => accessLevelOptions(summary?.levels ?? []), [summary]);
  const narrowed = isGrantListNarrowed(params);
  const rows = page?.items ?? [];
  const noGrantsAtAll = summary?.counts.all === 0;

  return (
    <DetailPanel
      title={t("title")}
      actions={
        <ExportButton
          path={applicationGrantsExportPath(applicationId)}
          params={applicationGrantPageFilterParams(params)}
          total={page?.total}
          filename="access-grants"
          permission="accessGrant:read"
          size="sm"
        />
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <StatusSegmented value={status} counts={summary?.counts} onChange={list.setStatus} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            {canSearchPeople ? (
              <SearchInput
                value={list.q}
                debounceMs={300}
                onDebouncedChange={list.setQ}
                maxLength={MAX_GRANT_QUERY_LENGTH}
                label={t("searchLabel")}
                placeholder={t("searchPlaceholder")}
                className="min-w-0 flex-1"
              />
            ) : null}
            {showAccessLevelPicker(levels, levelSelection, ANY_ACCESS_LEVEL) ? (
              <Select value={levelSelection} onValueChange={list.setLevel}>
                <SelectTrigger
                  size="sm"
                  className={cn("w-full sm:w-44", !canSearchPeople && "sm:ml-auto")}
                  aria-label={t("levelLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_ACCESS_LEVEL}>{t("levelAny")}</SelectItem>
                  {levels.map((option) => (
                    <SelectItem key={option.level} value={option.level}>
                      {option.level === NO_ACCESS_LEVEL ? t("levelNone") : option.level}
                    </SelectItem>
                  ))}
                  {levelSelection !== ANY_ACCESS_LEVEL &&
                  !levels.some((option) => option.level === levelSelection) ? (
                    <SelectItem value={levelSelection}>
                      {levelSelection === NO_ACCESS_LEVEL ? t("levelNone") : levelSelection}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>

        {isError ? (
          <ErrorState title={t("errorTitle")} onRetry={onRetry} error={error} />
        ) : !page ? (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
            {noGrantsAtAll && !narrowed ? (
              <UsersIcon className="size-6 text-muted-foreground/60" aria-hidden />
            ) : null}
            <p className="text-sm text-muted-foreground">
              {narrowed
                ? t("emptyFiltered")
                : noGrantsAtAll
                  ? canGrant
                    ? t("emptyDescription")
                    : t("emptyDescriptionReadOnly")
                  : t(`emptyStatus.${status}`)}
            </p>
            {narrowed ? (
              <Button size="sm" variant="outline" onClick={list.clearFilters}>
                {t("clearFilters")}
              </Button>
            ) : noGrantsAtAll && canGrant ? (
              <Button size="sm" onClick={onGrant}>
                <UserPlusIcon />
                {t("grant")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={cn("@container transition-opacity", isFetching && "opacity-60")}>
            <div
              aria-hidden
              className={cn(
                "hidden gap-x-4 border-b border-border pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
                ROW_GRID,
              )}
            >
              <span>{t("columns.person")}</span>
              <span>{t("columns.level")}</span>
              <span>{t("columns.granted")}</span>
              <span>{status === "revoked" ? t("columns.revoked") : t("columns.expires")}</span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {rows.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  applicationId={applicationId}
                  user={userById.get(grant.userId)}
                  userById={userById}
                  now={now}
                  canGrant={canGrant}
                  canReadWorkflows={canReadWorkflows}
                  onEdit={onEdit}
                  onRevoke={onRevoke}
                />
              ))}
            </ul>
          </div>
        )}

        {page ? (
          <Pagination
            total={page.total}
            limit={page.limit}
            offset={page.offset}
            itemCount={rows.length}
            onOffsetChange={list.setOffset}
            isFetching={isFetching}
          />
        ) : null}
      </div>
    </DetailPanel>
  );
}

function StatusSegmented({
  value,
  counts,
  onChange,
}: {
  value: ApplicationGrantStatus;
  counts: Record<ApplicationGrantStatus, number> | undefined;
  onChange: (next: ApplicationGrantStatus) => void;
}) {
  const t = useTranslations("applications.detail.access");
  return (
    <div
      role="group"
      aria-label={t("statusLabel")}
      className="inline-flex max-w-full shrink-0 items-center overflow-x-auto rounded-lg bg-muted p-0.5"
    >
      {GRANT_STATUS_FILTERS.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.8rem] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-background font-medium text-foreground shadow-xs ring-1 ring-foreground/10",
            )}
          >
            {t(`status.${option}`)}
            {counts ? (
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {counts[option]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function GrantRow({
  grant,
  applicationId,
  user,
  userById,
  now,
  canGrant,
  canReadWorkflows,
  onEdit,
  onRevoke,
}: {
  grant: AccessGrant;
  applicationId: string;
  user: UserListItem | undefined;
  userById: ReadonlyMap<string, UserListItem>;
  now: number;
  canGrant: boolean;
  canReadWorkflows: boolean;
  onEdit: (grant: AccessGrant) => void;
  onRevoke: (grant: AccessGrant) => void;
}) {
  const t = useTranslations("applications.detail.access");
  const { date } = useFormatters();
  const revoked = grant.revokedAt !== null;
  const gone = user?.deletedAt != null;
  const name = user ? `${user.firstName} ${user.lastName}` : t("unknownPerson");
  const actorName = (id: string | null) => {
    if (!id) return null;
    const actor = userById.get(id);
    return actor ? `${actor.firstName} ${actor.lastName}` : null;
  };
  const grantedBy = actorName(grant.grantedById);
  const revokedBy = actorName(grant.revokedById);
  const hasActions = canGrant && !revoked;

  return (
    <li
      className={cn(
        "relative gap-x-4 py-3",
        ROW_GRID,
        hasActions && "pr-10 @2xl:pr-0",
        revoked && "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {user ? (
          <UserAvatar
            size="sm"
            firstName={user.firstName}
            lastName={user.lastName}
            email={user.email}
            className={cn("mt-0.5", (gone || revoked) && "opacity-60 grayscale")}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {user ? (
              <Link
                href={`/users/${user.id}`}
                className={cn("truncate font-medium hover:underline", !revoked && "text-foreground")}
              >
                {name}
              </Link>
            ) : (
              <span className="truncate font-medium">{name}</span>
            )}
            {gone ? (
              <Badge variant="outline" className="text-muted-foreground">
                {t("deactivated")}
              </Badge>
            ) : null}
            {canReadWorkflows && !revoked ? (
              <GrantRunChip applicationId={applicationId} accessGrantId={grant.id} />
            ) : null}
          </div>
          {user?.email ? (
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          ) : null}
          {grant.notes ? (
            <p className="truncate text-xs text-muted-foreground" title={grant.notes}>
              <span aria-hidden className="font-mono text-muted-foreground/60">
                {"// "}
              </span>
              {grant.notes}
            </p>
          ) : null}
          {/* Narrow rows fold the level and dates under the person. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground @2xl:hidden">
            {grant.accessLevel ? <Badge variant="outline">{grant.accessLevel}</Badge> : null}
            <span className="font-mono tabular-nums">{t("grantedOn", { date: date(grant.grantedAt) })}</span>
            <GrantEndCell grant={grant} now={now} revokedBy={revokedBy} />
          </p>
        </div>
      </div>
      <div className="hidden min-w-0 @2xl:block">
        {grant.accessLevel ? (
          <Badge variant="outline" className="max-w-full truncate">
            {grant.accessLevel}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{t("levelNone")}</span>
        )}
      </div>
      <div className="hidden text-xs @2xl:block">
        <span className="font-mono tabular-nums">{date(grant.grantedAt)}</span>
        {grantedBy ? <span className="block truncate text-muted-foreground">{t("by", { name: grantedBy })}</span> : null}
      </div>
      <div className="hidden text-xs @2xl:block">
        <GrantEndCell grant={grant} now={now} revokedBy={revokedBy} stacked />
      </div>
      <div className="absolute top-2.5 right-0 @2xl:static @2xl:flex @2xl:justify-end">
        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name })}>
                <EllipsisHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={() => onEdit(grant)}>
                <PencilSquareIcon />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(grant)}>
                <NoSymbolIcon />
                {t("revoke")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}

/** Revoked rows show when and by whom; active ones show the expiry and how close it is. */
function GrantEndCell({
  grant,
  now,
  revokedBy,
  stacked = false,
}: {
  grant: AccessGrant;
  now: number;
  revokedBy: string | null;
  stacked?: boolean;
}) {
  const t = useTranslations("applications.detail.access");
  const { date } = useFormatters();
  if (grant.revokedAt) {
    return (
      <span className={stacked ? "block" : undefined}>
        <span className="font-mono tabular-nums">
          {stacked ? date(grant.revokedAt) : t("revokedOn", { date: date(grant.revokedAt) })}
        </span>
        {revokedBy ? (
          <span className={cn("truncate", stacked ? "block" : "ml-1")}>{t("by", { name: revokedBy })}</span>
        ) : null}
      </span>
    );
  }
  const expiry = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
  if (expiry.kind === "none") {
    return <span className="text-muted-foreground">{t("noExpiry")}</span>;
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", stacked && "flex")}>
      <span className="font-mono tabular-nums">
        {stacked ? date(grant.expiresAt as string) : t("expiresOn", { date: date(grant.expiresAt as string) })}
      </span>
      {expiry.kind === "expired" ? (
        <StatusBadge tone="danger">{t("expired")}</StatusBadge>
      ) : expiry.kind === "expiring" ? (
        <StatusBadge tone="warning">{t("expiresIn", { count: expiry.days })}</StatusBadge>
      ) : null}
    </span>
  );
}
