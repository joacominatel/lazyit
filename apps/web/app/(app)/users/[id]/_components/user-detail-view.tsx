"use client";

import {
  ArrowRightStartOnRectangleIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT, type User } from "@lazyit/shared";
import { useNow, useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import {
  AttentionItem,
  RecordAttention,
  RecordFact,
  RecordFacts,
  RecordHero,
  RecordLayout,
  TabCount,
  useRecordTab,
} from "@/components/record-page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorState } from "@/components/resource-table";
import { UserAvatar } from "@/components/user-avatar";
import { ConsumableDeliveriesPanel } from "@/components/consumables/consumable-deliveries-panel";
import type { DeliveryTargetRef } from "@/lib/consumables/deliveries";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useUser,
  useUserAssignments,
  useUserGrants,
} from "@/lib/api/hooks/use-users";
import {
  expiryState,
  GRANT_EXPIRING_WITHIN_DAYS,
} from "@/lib/record/record-state";
import { ArticleStatusBadge } from "../../../kb/_components/article-status-badge";
import { CloneUserWizard } from "../../_components/clone-user-wizard";
import { ManagerDisplay } from "../../_components/manager-display";
import { OffboardingSheet } from "../../_components/offboarding-sheet";
import { ProvisionAccountButton } from "../../_components/provision-account-button";
import { UserDirectoryBadge } from "../../_components/user-directory-badge";
import { UserFormDialog } from "../../_components/user-form-dialog";
import { UserPasswordResetButton } from "../../_components/user-password-reset-button";
import { UserRoleBadge } from "../../_components/user-role-badge";
import { UserRoleSelect } from "../../_components/user-role-select";
import { UserStatusBadge } from "../../_components/user-status-badge";
import { UserAccessTab } from "./user-access-tab";
import { UserAssetsTab } from "./user-assets-tab";
import { UserHistoryTab } from "./user-history-tab";

type UserTab = "assets" | "access" | "articles" | "consumables" | "history";

/**
 * User detail — the asset-centric counterpart to the asset detail page, as a record page (#1525). For
 * one person it answers what they hold ({@link useUserAssignments}), what applications they can reach
 * ({@link useUserGrants}) and what knowledge they wrote ({@link useArticles} by author): counters in
 * the summary card open the matching tab, the attention row flags what needs follow-up, and the
 * profile sits in the side column.
 *
 * Reads: the held assets resolve through the server-side `assignedToUserId` filter (complete for any
 * inventory size); application names through the applications catalog; released-asset names only when
 * the History tab opens. Grants are read only with `accessGrant:read`, and each tab is shown only when
 * its read is allowed.
 */
export function UserDetailView({ id }: { id: string }) {
  const t = useTranslations("users");
  const { date } = useFormatters();
  // Edit, Clone, Offboard and the role control are the coarse user:manage capability.
  const canManage = useCan("user:manage");
  const canReadGrants = useCan("accessGrant:read");
  const canReadArticles = useCan("article:read");
  const canReadConsumables = useCan("consumable:read");

  const { data: user, isLoading, isError, error, refetch } = useUser(id);
  // Active + released assignments and active + revoked grants for the full per-person picture.
  const { data: assignments } = useUserAssignments(id, false);
  const { data: grants } = useUserGrants(canReadGrants ? id : undefined, false);
  const { data: articlesPage } = useArticles({
    authorId: id,
    limit: MAX_PAGE_LIMIT,
  });
  // The assets this person holds now, with tag/model/category/status — scoped server-side.
  const heldFilters = useMemo(
    () => ({ assignedToUserId: id, limit: MAX_PAGE_LIMIT }),
    [id],
  );
  const { data: heldPage } = useAssets(heldFilters);
  const { data: applications } = useApplications();
  // The consumables delivered to this person (ADR-0098).
  const deliveryTarget = useMemo<DeliveryTargetRef>(
    () => ({ kind: "user", id }),
    [id],
  );
  // "Now" for the expiry comparison. next-intl's `useNow` starts from the server-render instant seeded
  // in the root layout, so the server and the hydrating client compare against the SAME value (#1448)
  // — a per-pass `Date.now()` could flip a grant that expires in between — and then ticks each minute
  // so a long-lived tab still sees a grant expire.
  const now = useNow({ updateInterval: 60 * 1000 }).getTime();

  const tabs = useMemo<UserTab[]>(() => {
    const visible: UserTab[] = ["assets"];
    if (canReadGrants) visible.push("access");
    if (canReadArticles) visible.push("articles");
    if (canReadConsumables) visible.push("consumables");
    visible.push("history");
    return visible;
  }, [canReadGrants, canReadArticles, canReadConsumables]);
  const [tab, setTab] = useRecordTab(tabs, "assets");

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/users" },
          { label: user ? `${user.firstName} ${user.lastName}` : "" },
        ]}
      />
    ),
    [t, user?.firstName, user?.lastName],
  );

  const [editOpen, setEditOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [offboardOpen, setOffboardOpen] = useState(false);

  const assetById = useMemo(
    () => new Map((heldPage?.items ?? []).map((asset) => [asset.id, asset])),
    [heldPage],
  );
  const appNameById = useMemo(
    () => new Map((applications ?? []).map((app) => [app.id, app.name])),
    [applications],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !user) {
    return (
      <div className="mx-auto max-w-6xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const fullName = `${user.firstName} ${user.lastName}`;
  const allAssignments = assignments ?? [];
  const allGrants = grants ?? [];
  const activeAssignments = allAssignments.filter((a) => a.releasedAt === null);
  const activeGrants = allGrants.filter((g) => g.revokedAt === null);
  const closedCount =
    allAssignments.length - activeAssignments.length + allGrants.length - activeGrants.length;
  const articles = articlesPage?.items ?? [];
  const publishedCount = articles.filter((a) => a.status === "PUBLISHED").length;

  let expiredGrants = 0;
  let expiringGrants = 0;
  for (const grant of activeGrants) {
    const state = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
    if (state.kind === "expired") expiredGrants += 1;
    else if (state.kind === "expiring") expiringGrants += 1;
  }
  const unacknowledged = activeAssignments.filter((a) => !a.acknowledgedAt).length;

  // What needs follow-up for this person, most severe first. Each item appears only while it applies.
  const attentionItems: ReactNode[] = [];
  if (expiredGrants > 0) {
    attentionItems.push(
      <AttentionItem key="expired" tone="danger" icon={ExclamationTriangleIcon}>
        {t("detail.attention.expiredGrants", { count: expiredGrants })}
      </AttentionItem>,
    );
  }
  if (expiringGrants > 0) {
    attentionItems.push(
      <AttentionItem key="expiring" tone="warning" icon={ClockIcon}>
        {t("detail.attention.expiringGrants", {
          count: expiringGrants,
          days: GRANT_EXPIRING_WITHIN_DAYS,
        })}
      </AttentionItem>,
    );
  }
  if (unacknowledged > 0) {
    attentionItems.push(
      <AttentionItem key="ack" tone="neutral" icon={ClockIcon}>
        {t("detail.attention.unacknowledged", { count: unacknowledged })}
      </AttentionItem>,
    );
  }

  // The four key facts. A counter the viewer cannot read gives its cell to the next fact in line.
  const facts: ReactNode[] = [
    <RecordFact
      key="assets"
      label={t("detail.facts.assets")}
      mono
      value={<span className="text-xl tracking-tight">{activeAssignments.length}</span>}
      sub={heldSummary(activeAssignments.map((a) => assetById.get(a.assetId)?.name), t)}
      onSelect={() => setTab("assets")}
      selectLabel={t("detail.facts.openTab", { tab: t("detail.tabs.assets") })}
    />,
  ];
  if (canReadGrants) {
    facts.push(
      <RecordFact
        key="access"
        label={t("detail.facts.access")}
        mono
        value={<span className="text-xl tracking-tight">{activeGrants.length}</span>}
        sub={
          expiredGrants > 0 || expiringGrants > 0
            ? t("detail.facts.accessAttention", { expired: expiredGrants, expiring: expiringGrants })
            : t("detail.facts.accessCalm")
        }
        onSelect={() => setTab("access")}
        selectLabel={t("detail.facts.openTab", { tab: t("detail.tabs.access") })}
      />,
    );
  }
  if (canReadArticles) {
    facts.push(
      <RecordFact
        key="articles"
        label={t("detail.facts.articles")}
        mono
        value={<span className="text-xl tracking-tight">{articles.length}</span>}
        sub={
          articles.length > 0
            ? t("detail.facts.articlesSplit", {
                published: publishedCount,
                drafts: articles.length - publishedCount,
              })
            : t("detail.facts.articlesNone")
        }
        onSelect={() => setTab("articles")}
        selectLabel={t("detail.facts.openTab", { tab: t("detail.tabs.articles") })}
      />,
    );
  }
  facts.push(
    <RecordFact
      key="manager"
      label={t("detail.fields.manager")}
      value={
        <span className="truncate font-medium">
          <ManagerDisplay manager={user.manager} />
        </span>
      }
    />,
    <RecordFact
      key="joined"
      label={t("detail.fields.joined")}
      mono
      value={date(user.createdAt)}
    />,
    <RecordFact
      key="updated"
      label={t("detail.fields.lastUpdated")}
      mono
      value={date(user.updatedAt)}
    />,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {breadcrumb}

      <RecordHero
        header={
          <PageHeader
            title={
              <span className="flex items-center gap-3">
                <UserAvatar
                  size="lg"
                  firstName={user.firstName}
                  lastName={user.lastName}
                  email={user.email}
                />
                {fullName}
              </span>
            }
            badge={
              <span className="flex flex-wrap items-center gap-2">
                <UserStatusBadge isActive={user.isActive} />
                <UserRoleBadge role={user.role} />
                {user.directoryOnly && <UserDirectoryBadge />}
              </span>
            }
            subtitle={<UserIdentityLine user={user} />}
            actions={
              canManage ? (
                <>
                  <UserPasswordResetButton user={user} />
                  <Button size="sm" onClick={() => setEditOpen(true)}>
                    <PencilSquareIcon />
                    {t("detail.edit")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={t("detail.moreActions")}
                      >
                        <EllipsisHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52">
                      <DropdownMenuItem onSelect={() => setCloneOpen(true)}>
                        <DocumentDuplicateIcon />
                        {t("clone.action")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setOffboardOpen(true)}
                      >
                        <ArrowRightStartOnRectangleIcon />
                        {t("detail.offboard")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : undefined
            }
          />
        }
        attention={
          <RecordAttention label={t("detail.attention.label")} items={attentionItems} />
        }
        facts={<RecordFacts>{facts.slice(0, 4)}</RecordFacts>}
      />

      <RecordLayout
        main={
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label={t("detail.tabs.label")}>
              <TabsTrigger value="assets" className="group/tab">
                {t("detail.tabs.assets")}
                <TabCount value={assignments ? activeAssignments.length : undefined} />
              </TabsTrigger>
              {canReadGrants ? (
                <TabsTrigger value="access" className="group/tab">
                  {t("detail.tabs.access")}
                  <TabCount value={grants ? activeGrants.length : undefined} />
                </TabsTrigger>
              ) : null}
              {canReadArticles ? (
                <TabsTrigger value="articles" className="group/tab">
                  {t("detail.tabs.articles")}
                  <TabCount value={articlesPage ? articles.length : undefined} />
                </TabsTrigger>
              ) : null}
              {canReadConsumables ? (
                <TabsTrigger value="consumables">{t("detail.tabs.consumables")}</TabsTrigger>
              ) : null}
              <TabsTrigger value="history" className="group/tab">
                {t("detail.tabs.history")}
                <TabCount value={assignments ? closedCount : undefined} />
              </TabsTrigger>
            </TabsList>

            <TabsContent value="assets" className="pt-2">
              <UserAssetsTab
                userId={user.id}
                active={activeAssignments}
                assetById={assetById}
              />
            </TabsContent>

            {canReadGrants ? (
              <TabsContent value="access" className="pt-2">
                <UserAccessTab active={activeGrants} appNameById={appNameById} now={now} />
              </TabsContent>
            ) : null}

            {canReadArticles ? (
              <TabsContent value="articles" className="pt-2">
                <DetailPanel title={t("detail.articles.title")}>
                  {articles.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("detail.articles.empty")}
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {articles.map((article) => (
                        <li
                          key={article.id}
                          className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <Link
                              href={`/kb/${article.slug}`}
                              className="truncate font-medium hover:underline"
                            >
                              {article.title}
                            </Link>
                            {article.excerpt && (
                              <p className="truncate text-sm text-muted-foreground">
                                {article.excerpt}
                              </p>
                            )}
                          </div>
                          <ArticleStatusBadge status={article.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </DetailPanel>
              </TabsContent>
            ) : null}

            {canReadConsumables ? (
              <TabsContent value="consumables" className="pt-2">
                <ConsumableDeliveriesPanel
                  target={deliveryTarget}
                  targetName={fullName}
                  targetLive={user.deletedAt == null}
                />
              </TabsContent>
            ) : null}

            <TabsContent value="history" className="pt-2">
              <UserHistoryTab
                assignments={allAssignments}
                grants={allGrants}
                appNameById={appNameById}
              />
            </TabsContent>
          </Tabs>
        }
        aside={
          <>
            {/* Directory person (ADR-0069 REDESIGN §0 #3): no login yet. */}
            {user.directoryOnly && canManage && (
              <DetailPanel title={t("directory.provision.title")}>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {t("directory.provision.description")}
                  </p>
                  <ProvisionAccountButton user={user} />
                </div>
              </DetailPanel>
            )}
            <DetailPanel title={t("detail.profile")}>
              <dl className="divide-y divide-border text-sm">
                <ProfileRow label={t("detail.fields.role")}>
                  <UserRoleSelect user={user} size="sm" />
                </ProfileRow>
                <ProfileRow label={t("detail.fields.manager")}>
                  <ManagerDisplay manager={user.manager} />
                </ProfileRow>
                <ProfileRow label={t("detail.fields.legajo")} mono>
                  {user.legajo ?? <Empty />}
                </ProfileRow>
                <ProfileRow label={t("detail.fields.username")} mono>
                  {user.username ?? <Empty />}
                </ProfileRow>
                <ProfileRow label={t("detail.fields.email")}>
                  <span className="break-words">{user.email}</span>
                </ProfileRow>
                <ProfileRow label={t("detail.fields.joined")} mono>
                  {date(user.createdAt)}
                </ProfileRow>
                <ProfileRow label={t("detail.fields.lastUpdated")} mono>
                  {date(user.updatedAt)}
                </ProfileRow>
              </dl>
            </DetailPanel>
          </>
        }
      />

      <UserFormDialog
        key={`edit-${user.id}`}
        open={editOpen}
        onOpenChange={setEditOpen}
        user={user}
      />
      {cloneOpen ? (
        <CloneUserWizard
          key={`clone-${user.id}`}
          open
          onOpenChange={setCloneOpen}
          source={{
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
          }}
        />
      ) : null}
      <OffboardingSheet
        key={`offboard-${user.id}`}
        open={offboardOpen}
        onOpenChange={setOffboardOpen}
        user={{
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
        }}
      />
    </div>
  );
}

/** The held-assets fact's caption: up to two names, then "+N more"; nothing while names resolve. */
function heldSummary(
  names: (string | undefined)[],
  t: ReturnType<typeof useTranslations<"users">>,
): string {
  if (names.length === 0) return t("detail.facts.assetsNone");
  const known = names.filter((name): name is string => Boolean(name));
  if (known.length === 0) return t("detail.facts.assetsCount", { count: names.length });
  const shown = known.slice(0, 2).join(", ");
  const rest = names.length - Math.min(2, known.length);
  return rest > 0 ? t("detail.facts.assetsMore", { names: shown, count: rest }) : shown;
}

/** The header's identity line: the copyable email, then username and employee number when set. */
function UserIdentityLine({ user }: { user: User }) {
  const t = useTranslations("users.detail");
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
        <span className="break-all">{user.email}</span>
        <CopyButton value={user.email} label={t("copyEmail")} className="-my-1" />
      </span>
      {user.username ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="font-mono">{user.username}</span>
        </>
      ) : null}
      {user.legajo ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span>
            {t("fields.legajo")} <span className="font-mono">{user.legajo}</span>
          </span>
        </>
      ) : null}
    </span>
  );
}

/** One label/value row of the side-column profile. */
function ProfileRow({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono tabular-nums" : undefined}>{children}</dd>
    </div>
  );
}

function Empty() {
  const t = useTranslations("users.detail");
  return <span className="text-muted-foreground">{t("fieldEmpty")}</span>;
}
