"use client";

import {
  ArrowTopRightOnSquareIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  KeyIcon,
  PencilSquareIcon,
  ShieldExclamationIcon,
  TrashIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { type AccessGrant, type Application, isSafeApplicationUrl } from "@lazyit/shared";
import { useLocale, useNow, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useReducer, useState } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
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
import { RelatedArticlesPanel } from "@/components/related-articles-panel";
import { ErrorState } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRevokeGrant } from "@/lib/api/hooks/use-access-grant-mutations";
import { useAccessRequests } from "@/lib/api/hooks/use-access-requests";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useDeleteApplication } from "@/lib/api/hooks/use-application-mutations";
import { useApplication, useApplicationGrants } from "@/lib/api/hooks/use-applications";
import { useUserNames } from "@/lib/api/hooks/use-users";
import {
  grantExpiryCounts,
  grantStatusCounts,
  type GrantStatusFilter,
  seatState,
} from "@/lib/applications/grant-view";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { expiryState, GRANT_EXPIRING_WITHIN_DAYS } from "@/lib/record/record-state";
import { formatMoney } from "@/lib/utils/money";
import { EditGrantDialog } from "../../_components/edit-grant-dialog";
import { GrantAccessDialog } from "../../_components/grant-access-dialog";
import { RequestAccessButton } from "../../_components/request-access-button";
import { RevokeGrantDialog } from "../../_components/revoke-grant-dialog";
import { ApplicationAccessTab } from "./application-access-tab";
import { ApplicationActivityTab } from "./application-activity-tab";
import { ApplicationAutomationTab } from "./application-automation-tab";
import { ApplicationRequestsTab } from "./application-requests-tab";

type ApplicationTab = "access" | "requests" | "automation" | "activity" | "about";

const ALL_GRANTS = { activeOnly: false };

/** isSafeApplicationUrl guarantees scheme-less or http(s); make scheme-less hosts absolute (SEC-008). */
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

type DialogState = {
  grantOpen: boolean;
  deleteOpen: boolean;
  revoking: AccessGrant | null;
  editing: AccessGrant | null;
};

type DialogAction =
  | { type: "setGrantOpen"; open: boolean }
  | { type: "setDeleteOpen"; open: boolean }
  | { type: "setRevoking"; grant: AccessGrant | null }
  | { type: "setEditing"; grant: AccessGrant | null };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "setGrantOpen":
      return { ...state, grantOpen: action.open };
    case "setDeleteOpen":
      return { ...state, deleteOpen: action.open };
    case "setRevoking":
      return { ...state, revoking: action.grant };
    case "setEditing":
      return { ...state, editing: action.grant };
  }
}

/** The application record page (#1650, the #1525 frame); each tab renders only for a viewer who can read it. */
export function ApplicationDetailView({ id }: { id: string }) {
  const t = useTranslations("applications.detail");
  const tList = useTranslations("applications.list");
  const router = useRouter();
  const canWrite = useCan("application:write");
  const canDelete = useCan("application:delete");
  const canGrant = useCan("accessGrant:grant");
  const canReadGrants = useCan("accessGrant:read");
  const canReadRequests = useCan("accessRequest:read");
  const canReadWorkflows = useCan("workflow:read");
  const canReadLogs = useCan("logs:read");
  // The server-render instant, then a per-minute tick (#1448): server and client agree on expiry.
  const now = useNow({ updateInterval: 60 * 1000 }).getTime();

  const { data: application, isLoading, isError, error, refetch } = useApplication(id);
  const grantsQuery = useApplicationGrants(canReadGrants ? id : undefined, ALL_GRANTS);
  const grants = grantsQuery.data;
  const { data: pendingPage } = useAccessRequests(
    { applicationId: id, status: "PENDING", limit: 1 },
    { enabled: canReadRequests },
  );
  const { data: categories } = useApplicationCategories();
  const revokeGrant = useRevokeGrant();
  const deleteApplication = useDeleteApplication();

  // Grantees and the people who granted or revoked, so every row and "by …" line resolves.
  const personIds = useMemo(() => {
    const ids: string[] = [];
    for (const grant of grants ?? []) {
      ids.push(grant.userId);
      if (grant.grantedById) ids.push(grant.grantedById);
      if (grant.revokedById) ids.push(grant.revokedById);
    }
    return ids;
  }, [grants]);
  const userById = useUserNames(personIds);

  const tabs = useMemo<ApplicationTab[]>(() => {
    const visible: ApplicationTab[] = [];
    if (canReadGrants) visible.push("access");
    if (canReadRequests) visible.push("requests");
    if (canReadWorkflows) visible.push("automation");
    if (canReadLogs) visible.push("activity");
    visible.push("about");
    return visible;
  }, [canReadGrants, canReadRequests, canReadWorkflows, canReadLogs]);
  const [tab, setTab] = useRecordTab(tabs, tabs[0]);
  const [grantStatus, setGrantStatus] = useState<GrantStatusFilter>("active");

  const [dialog, dispatchDialog] = useReducer(dialogReducer, {
    grantOpen: false,
    deleteOpen: false,
    revoking: null,
    editing: null,
  });

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tList("title"), href: "/applications" },
          { label: application?.name ?? "" },
        ]}
      />
    ),
    [tList, application?.name],
  );

  const counts = useMemo(() => grantStatusCounts(grants ?? [], now), [grants, now]);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !application) {
    return (
      <div className="mx-auto max-w-6xl">
        <ErrorState
          title={t("notFoundTitle")}
          description={t("notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const category = application.categoryId
    ? categories?.find((c) => c.id === application.categoryId)
    : undefined;
  const seats = seatState(application);
  const renewal = expiryState(application.renewalDate, now, GRANT_EXPIRING_WITHIN_DAYS);
  const expiry = grantExpiryCounts(grants ?? [], now);
  const pendingCount = pendingPage?.total;
  const deactivatedHolders = new Set(
    (grants ?? [])
      .filter((g) => g.revokedAt === null && userById.get(g.userId)?.deletedAt != null)
      .map((g) => g.userId),
  ).size;

  function openGrants(status: GrantStatusFilter) {
    setGrantStatus(status);
    setTab("access");
  }

  function personName(userId: string): string {
    const user = userById.get(userId);
    return user ? `${user.firstName} ${user.lastName}` : t("access.unknownPerson");
  }

  // What needs follow-up on this application, most severe first.
  const attentionItems: ReactNode[] = [];
  if (expiry.expired > 0) {
    attentionItems.push(
      <AttentionItem key="expired" tone="danger" icon={ExclamationTriangleIcon}>
        {t("attention.expiredGrants", { count: expiry.expired })}
      </AttentionItem>,
    );
  }
  if (seats.overBy > 0) {
    attentionItems.push(
      <AttentionItem key="over" tone="warning" icon={ExclamationTriangleIcon}>
        {t("attention.overAllocated", { count: seats.overBy })}
      </AttentionItem>,
    );
  }
  if (renewal.kind === "expired" || renewal.kind === "expiring") {
    attentionItems.push(
      <AttentionItem key="renewal" tone="warning" icon={ClockIcon}>
        {renewal.kind === "expired"
          ? t("attention.renewalPassed", { count: renewal.days })
          : t("attention.renewalSoon", { count: renewal.days })}
      </AttentionItem>,
    );
  }
  if (expiry.expiring > 0) {
    attentionItems.push(
      <AttentionItem key="expiring" tone="warning" icon={ClockIcon}>
        {t("attention.expiringGrants", { count: expiry.expiring, days: GRANT_EXPIRING_WITHIN_DAYS })}
      </AttentionItem>,
    );
  }
  if (deactivatedHolders > 0) {
    attentionItems.push(
      <AttentionItem key="deactivated" tone="warning" icon={UserMinusIcon}>
        {t("attention.deactivatedHolders", { count: deactivatedHolders })}
      </AttentionItem>,
    );
  }
  if (pendingCount) {
    attentionItems.push(
      <AttentionItem key="pending" tone="neutral" icon={InboxIcon}>
        {t("attention.pendingRequests", { count: pendingCount })}
      </AttentionItem>,
    );
  }

  const facts: ReactNode[] = [
    <RecordFact
      key="people"
      label={t("facts.people")}
      mono
      value={<span className="text-xl tracking-tight">{seats.used}</span>}
      sub={
        grants
          ? expiry.expired + expiry.expiring > 0
            ? t("facts.grantsAttention", {
                count: counts.active,
                expiring: expiry.expired + expiry.expiring,
              })
            : t("facts.grants", { count: counts.active })
          : undefined
      }
      onSelect={canReadGrants ? () => openGrants("active") : undefined}
      selectLabel={t("facts.openTab", { tab: t("tabs.access") })}
    />,
    <SeatsFact key="seats" application={application} />,
    <RenewalFact key="renewal" renewalDate={application.renewalDate ?? null} now={now} />,
  ];
  if (canReadRequests) {
    facts.push(
      <RecordFact
        key="requests"
        label={t("facts.pending")}
        mono
        tone={pendingCount ? "warning" : undefined}
        value={<span className="text-xl tracking-tight">{pendingCount ?? "—"}</span>}
        sub={pendingCount ? t("facts.pendingSub") : t("facts.pendingNone")}
        onSelect={() => setTab("requests")}
        selectLabel={t("facts.openTab", { tab: t("tabs.requests") })}
      />,
    );
  }
  facts.push(<AddedFact key="added" application={application} />);

  const hasMenu = canWrite || canDelete;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {breadcrumb}

      <RecordHero
        header={
          <PageHeader
            pillar="access"
            icon={KeyIcon}
            title={application.name}
            badge={
              application.isCritical ? (
                <Badge variant="destructive" className="gap-1">
                  <ShieldExclamationIcon className="size-3.5" aria-hidden />
                  {t("criticalBadge")}
                </Badge>
              ) : undefined
            }
            subtitle={<IdentityLine application={application} categoryName={category?.name} />}
            actions={
              <>
                {canGrant ? (
                  <Button size="sm" onClick={() => dispatchDialog({ type: "setGrantOpen", open: true })}>
                    <UserPlusIcon />
                    {t("grantAccess")}
                  </Button>
                ) : (
                  <RequestAccessButton applicationId={application.id} />
                )}
                {canWrite ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/applications/${application.id}/edit`}>
                      <PencilSquareIcon />
                      {t("edit")}
                    </Link>
                  </Button>
                ) : null}
                {hasMenu ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon-sm" aria-label={t("moreActions")}>
                        <EllipsisHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                      {canWrite ? (
                        <DropdownMenuItem asChild>
                          <Link href={`/applications/${application.id}/clone`}>
                            <DocumentDuplicateIcon />
                            {t("clone")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? (
                        <>
                          {canWrite ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => dispatchDialog({ type: "setDeleteOpen", open: true })}
                          >
                            <TrashIcon />
                            {t("deleteLabel")}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            }
          />
        }
        attention={<RecordAttention label={t("attention.label")} items={attentionItems} />}
        facts={<RecordFacts>{facts.slice(0, 4)}</RecordFacts>}
      />

      <RecordLayout
        main={
          <Tabs value={tab} onValueChange={setTab}>
            <div className="max-w-full overflow-x-auto">
              <TabsList aria-label={t("tabs.label")}>
                {canReadGrants ? (
                  <TabsTrigger value="access" className="group/tab">
                    {t("tabs.access")}
                    <TabCount value={grants ? counts.active : undefined} />
                  </TabsTrigger>
                ) : null}
                {canReadRequests ? (
                  <TabsTrigger value="requests" className="group/tab">
                    {t("tabs.requests")}
                    <TabCount value={pendingCount || undefined} />
                  </TabsTrigger>
                ) : null}
                {canReadWorkflows ? (
                  <TabsTrigger value="automation">{t("tabs.automation")}</TabsTrigger>
                ) : null}
                {canReadLogs ? (
                  <TabsTrigger value="activity">{t("tabs.activity")}</TabsTrigger>
                ) : null}
                <TabsTrigger value="about">{t("tabs.about")}</TabsTrigger>
              </TabsList>
            </div>

            {canReadGrants ? (
              <TabsContent value="access" className="pt-2">
                <ApplicationAccessTab
                  applicationId={application.id}
                  grants={grants}
                  isError={grantsQuery.isError}
                  error={grantsQuery.error}
                  onRetry={() => grantsQuery.refetch()}
                  counts={counts}
                  userById={userById}
                  now={now}
                  status={grantStatus}
                  onStatusChange={setGrantStatus}
                  canGrant={canGrant}
                  canReadWorkflows={canReadWorkflows}
                  onGrant={() => dispatchDialog({ type: "setGrantOpen", open: true })}
                  onEdit={(grant) => dispatchDialog({ type: "setEditing", grant })}
                  onRevoke={(grant) => dispatchDialog({ type: "setRevoking", grant })}
                />
              </TabsContent>
            ) : null}

            {canReadRequests ? (
              <TabsContent value="requests" className="pt-2">
                <ApplicationRequestsTab applicationId={application.id} pendingCount={pendingCount} />
              </TabsContent>
            ) : null}

            {canReadWorkflows ? (
              <TabsContent value="automation" className="pt-2">
                <ApplicationAutomationTab
                  applicationId={application.id}
                  isCritical={application.isCritical}
                />
              </TabsContent>
            ) : null}

            {canReadLogs ? (
              <TabsContent value="activity" className="pt-2">
                <ApplicationActivityTab applicationId={application.id} />
              </TabsContent>
            ) : null}

            <TabsContent value="about" className="space-y-4 pt-2">
              <AboutPanel application={application} />
            </TabsContent>
          </Tabs>
        }
        aside={
          <>
            <PropertiesPanel application={application} categoryName={category?.name} />
            <RelatedArticlesPanel applicationId={application.id} />
          </>
        }
      />

      <GrantAccessDialog
        open={dialog.grantOpen}
        onOpenChange={(open) => dispatchDialog({ type: "setGrantOpen", open })}
        applicationId={application.id}
      />
      <EditGrantDialog
        grant={dialog.editing}
        onOpenChange={(open) => {
          if (!open) dispatchDialog({ type: "setEditing", grant: null });
        }}
        userName={dialog.editing ? personName(dialog.editing.userId) : ""}
      />
      <RevokeGrantDialog
        open={dialog.revoking != null}
        onOpenChange={(open) => {
          if (!open) dispatchDialog({ type: "setRevoking", grant: null });
        }}
        userName={dialog.revoking ? personName(dialog.revoking.userId) : ""}
        accessLevel={dialog.revoking?.accessLevel}
        onConfirm={() => revokeGrant.mutateAsync({ id: (dialog.revoking as AccessGrant).id })}
      />
      <DeleteConfirmDialog
        open={dialog.deleteOpen}
        onOpenChange={(open) => dispatchDialog({ type: "setDeleteOpen", open })}
        entityKey="application"
        name={application.name}
        onConfirm={() => deleteApplication.mutateAsync(application.id)}
        onDeleted={() => router.push("/applications")}
      />
    </div>
  );
}

function IdentityLine({
  application,
  categoryName,
}: {
  application: Application;
  categoryName: string | undefined;
}) {
  const parts: ReactNode[] = [];
  if (application.vendor) parts.push(<span key="vendor">{application.vendor}</span>);
  if (application.categoryId && categoryName) {
    parts.push(
      <Link
        key="category"
        href={`/applications?category=${application.categoryId}`}
        className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Badge variant="outline" className="hover:bg-muted">
          {categoryName}
        </Badge>
      </Link>,
    );
  }
  if (application.url) parts.push(<AppUrl key="url" url={application.url} />);
  if (parts.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {parts.map((part, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function AppUrl({ url }: { url: string }) {
  const t = useTranslations("applications.detail");
  if (!isSafeApplicationUrl(url)) return <span className="break-all">{url}</span>;
  return (
    <a
      href={toHref(url)}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-w-0 items-center gap-1 break-all text-primary hover:underline"
    >
      {url}
      <ArrowTopRightOnSquareIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{t("opensInNewTab")}</span>
    </a>
  );
}

function SeatsFact({ application }: { application: Application }) {
  const t = useTranslations("applications.detail.facts");
  const locale = useLocale();
  const seats = seatState(application);
  const cost =
    application.costPerSeat != null
      ? t("costPerSeat", { cost: formatMoney(application.costPerSeat, locale) })
      : undefined;
  if (seats.purchased === null) {
    return (
      <RecordFact
        label={t("seats")}
        value={<span className="font-normal text-muted-foreground">{t("seatsUntracked")}</span>}
        sub={cost}
      />
    );
  }
  return (
    <RecordFact
      label={t("seats")}
      mono
      tone={seats.overBy > 0 ? "warning" : undefined}
      value={t("seatsValue", { used: seats.used, purchased: seats.purchased })}
      sub={
        <>
          {seats.overBy > 0 ? t("seatsOver", { count: seats.overBy }) : t("seatsFree", { count: seats.free })}
          {cost ? ` · ${cost}` : null}
        </>
      }
      meter={seats.fill ?? undefined}
    />
  );
}

function RenewalFact({ renewalDate, now }: { renewalDate: string | null; now: number }) {
  const t = useTranslations("applications.detail.facts");
  const { date } = useFormatters();
  const state = expiryState(renewalDate, now, GRANT_EXPIRING_WITHIN_DAYS);
  if (state.kind === "none" || !renewalDate) {
    return (
      <RecordFact
        label={t("renewal")}
        value={<span className="font-normal text-muted-foreground">{t("renewalNone")}</span>}
      />
    );
  }
  return (
    <RecordFact
      label={t("renewal")}
      mono
      tone={state.kind === "expired" ? "danger" : state.kind === "expiring" ? "warning" : undefined}
      value={date(renewalDate)}
      sub={
        state.kind === "expired"
          ? t("renewalPassed", { count: state.days })
          : t("renewalIn", { count: state.days })
      }
    />
  );
}

function AddedFact({ application }: { application: Application }) {
  const t = useTranslations("applications.detail.facts");
  const { date } = useFormatters();
  return (
    <RecordFact
      label={t("added")}
      mono
      value={date(application.createdAt)}
      sub={t("updated", { date: date(application.updatedAt) })}
    />
  );
}

function AboutPanel({ application }: { application: Application }) {
  const t = useTranslations("applications.detail");
  const locale = useLocale();
  const { date } = useFormatters();
  const seats = seatState(application);
  const hasLicense =
    application.seatsPurchased != null ||
    application.costPerSeat != null ||
    application.renewalDate != null;
  return (
    <>
      <DetailPanel title={t("about.title")}>
        {application.description ? (
          <p className="text-sm break-words whitespace-pre-wrap">{application.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("about.noDescription")}</p>
        )}
        {application.notes ? (
          <div className="mt-5 space-y-1 rounded-lg bg-muted px-3 py-2.5">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("notesLabel")}
            </p>
            <p className="text-sm break-words whitespace-pre-wrap">{application.notes}</p>
          </div>
        ) : null}
      </DetailPanel>
      <DetailPanel title={t("licenseTitle")}>
        {hasLicense ? (
          <dl className="divide-y divide-border text-sm">
            <PropertyRow label={t("seatsLabel")} mono>
              {seats.purchased !== null
                ? t("facts.seatsValue", { used: seats.used, purchased: seats.purchased })
                : t("seatsUsedUntracked", { used: seats.used })}
            </PropertyRow>
            <PropertyRow label={t("costPerSeatLabel")} mono>
              {application.costPerSeat != null ? formatMoney(application.costPerSeat, locale) : <Empty />}
            </PropertyRow>
            <PropertyRow label={t("renewalDateLabel")} mono>
              {application.renewalDate ? date(application.renewalDate) : <Empty />}
            </PropertyRow>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("about.noLicense")}</p>
        )}
      </DetailPanel>
    </>
  );
}

function PropertiesPanel({
  application,
  categoryName,
}: {
  application: Application;
  categoryName: string | undefined;
}) {
  const t = useTranslations("applications.detail");
  const { date } = useFormatters();
  return (
    <DetailPanel title={t("detailsTitle")}>
      <dl className="divide-y divide-border text-sm">
        <PropertyRow label={t("vendorLabel")}>{application.vendor ?? <Empty />}</PropertyRow>
        <PropertyRow label={t("categoryLabel")}>
          {application.categoryId && categoryName ? (
            <Link href={`/applications?category=${application.categoryId}`} className="hover:underline">
              {categoryName}
            </Link>
          ) : (
            <Empty />
          )}
        </PropertyRow>
        <PropertyRow label={t("urlLabel")}>
          {application.url ? <AppUrl url={application.url} /> : <Empty />}
        </PropertyRow>
        <PropertyRow label={t("criticalityLabel")}>
          {application.isCritical ? (
            <span className="font-medium text-destructive-text">{t("criticalBadge")}</span>
          ) : (
            <span className="text-muted-foreground">{t("notCritical")}</span>
          )}
        </PropertyRow>
        <PropertyRow label={t("facts.added")} mono>
          {date(application.createdAt)}
        </PropertyRow>
        <PropertyRow label={t("lastUpdated")} mono>
          {date(application.updatedAt)}
        </PropertyRow>
      </dl>
      {application.isCritical ? (
        <p className="mt-4 flex gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive-text">
          <ShieldExclamationIcon className="mt-px size-4 shrink-0" aria-hidden />
          <span>
            {t("critical.note")}{" "}
            <Link href="/help/applications-criticality-alerts" className="font-medium underline">
              {t("critical.learnMore")}
            </Link>
          </span>
        </p>
      ) : null}
    </DetailPanel>
  );
}

function PropertyRow({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono tabular-nums" : "min-w-0 break-words"}>{children}</dd>
    </div>
  );
}

function Empty() {
  const t = useTranslations("applications.detail");
  return <span className="text-muted-foreground">{t("notSet")}</span>;
}
