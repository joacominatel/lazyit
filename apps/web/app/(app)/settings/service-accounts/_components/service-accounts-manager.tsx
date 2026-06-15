"use client";

import {
  ArrowPathIcon,
  BeakerIcon,
  EllipsisVerticalIcon,
  KeyIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type Permission,
  type ServiceAccount,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RestoreRowAction,
} from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { notifyError } from "@/lib/api/notify-error";
import {
  useRestoreServiceAccount,
  useRevokeServiceAccount,
  useServiceAccounts,
} from "@/lib/api/hooks/use-service-accounts";
import { useCan } from "@/lib/hooks/use-permissions";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { permissionLabel } from "../../_lib/permission-labels";
import { RotateDialog } from "./rotate-dialog";
import { ServiceAccountFormDialog } from "./service-account-form-dialog";
import {
  serviceAccountStatus,
  STATUS_TONE,
} from "./service-account-status";
import { TestItDialog } from "./test-it-dialog";

const MAX_PERMISSION_LABELS = 2;

/**
 * The Service Accounts admin list (ADR-0048). A ResourceTable of the instance's non-human credentials
 * with row actions (Edit / Rotate / Revoke), a "Show revoked" toggle that switches to the archived
 * (`includeRevoked`) view with per-row Restore, and a create flow that ends in the one-time secret
 * reveal. Everything writes through `settings:manage`-gated endpoints — the screen lives behind the
 * AdminGate and re-checks `can('settings:manage')` here so a non-holder sees a read-only list.
 */
export function ServiceAccountsManager() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { relative } = useFormatters();
  // A render-stable "now" so the status/expiry derivation (serviceAccountStatus) stays pure.
  const [now] = useState(() => Date.now());
  const [showRevoked, setShowRevoked] = useState(false);
  const { data, isLoading, isError, error, refetch } =
    useServiceAccounts(showRevoked);

  const canManage = useCan("settings:manage");

  const columns: ResourceColumn[] = [
    {
      key: "name",
      header: t("serviceAccounts.columns.name"),
      skeleton: <Skeleton className="h-4 w-40" />,
    },
    {
      key: "token",
      header: t("serviceAccounts.columns.token"),
      skeleton: <Skeleton className="h-4 w-28" />,
    },
    {
      key: "permissions",
      header: t("serviceAccounts.columns.permissions"),
      skeleton: <Skeleton className="h-4 w-44" />,
    },
    {
      key: "lastUsed",
      header: t("serviceAccounts.columns.lastUsed"),
      headClassName: "w-28",
      skeleton: <Skeleton className="h-4 w-16" />,
    },
    {
      key: "status",
      header: t("serviceAccounts.columns.status"),
      headClassName: "w-24",
      skeleton: <Skeleton className="h-5 w-16 rounded-4xl" />,
    },
    {
      key: "actions",
      header: tc("actions"),
      srOnlyHeader: true,
      headClassName: "w-12 text-right",
      skeleton: <Skeleton className="ml-auto size-7" />,
    },
  ];

  /** A short "3 permissions · View assets, Add & edit assets, +1 more" summary for the table cell. */
  function permissionsSummary(permissions: Permission[]): string {
    if (permissions.length === 0) return t("serviceAccounts.permissionsSummary.none");
    const labels = permissions
      .slice(0, MAX_PERMISSION_LABELS)
      .map((p) => permissionLabel(t, p));
    const extra = permissions.length - labels.length;
    const count = t("serviceAccounts.permissionsSummary.count", {
      count: permissions.length,
    });
    const tail =
      extra > 0
        ? `, ${t("serviceAccounts.permissionsSummary.extra", { count: extra })}`
        : "";
    return `${count} · ${labels.join(", ")}${tail}`;
  }

  const revoke = useRevokeServiceAccount();
  const restore = useRestoreServiceAccount();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceAccount | undefined>(undefined);
  const [rotating, setRotating] = useState<ServiceAccount | undefined>(
    undefined,
  );
  const [revoking, setRevoking] = useState<ServiceAccount | undefined>(
    undefined,
  );
  const [testing, setTesting] = useState<ServiceAccount | undefined>(undefined);

  const accounts = data ?? [];
  const hasData = accounts.length > 0;

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(account: ServiceAccount) {
    setEditing(account);
    setFormOpen(true);
  }

  function handleRestore(account: ServiceAccount) {
    restore.mutate(account.id, {
      onSuccess: () => toast.success(t("serviceAccounts.toast.restored")),
      onError: (err) =>
        notifyError(err, t("serviceAccounts.toast.restoreError")),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={showRevoked}
            onCheckedChange={setShowRevoked}
            aria-label={t("serviceAccounts.showRevokedAria")}
          />
          {t("serviceAccounts.showRevoked")}
        </label>
        {canManage && !showRevoked ? (
          <Button onClick={openCreate} size="sm">
            <PlusIcon />
            {t("serviceAccounts.newAccount")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <ResourceTable columns={columns} isLoading />
      ) : isError ? (
        <ErrorState
          title={t("serviceAccounts.loadError")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={KeyIcon}
          pillar="access"
          title={
            showRevoked
              ? t("serviceAccounts.empty.revokedTitle")
              : t("serviceAccounts.empty.title")
          }
          description={
            showRevoked
              ? t("serviceAccounts.empty.revokedDescription")
              : t("serviceAccounts.empty.description")
          }
          action={
            canManage && !showRevoked
              ? {
                  label: t("serviceAccounts.empty.action"),
                  onClick: openCreate,
                }
              : undefined
          }
        />
      ) : (
        <ResourceTable columns={columns}>
          {accounts.map((account) => {
            const status = serviceAccountStatus(account, now);
            const isRevoked = status === "revoked";
            return (
              <TableRow key={account.id}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {account.name}
                    {account.systemManaged ? (
                      <StatusBadge
                        tone="info"
                        title={t("serviceAccounts.systemManaged.hint")}
                      >
                        <LockClosedIcon />
                        {t("serviceAccounts.systemManaged.badge")}
                      </StatusBadge>
                    ) : null}
                  </span>
                  {account.description ? (
                    <p className="truncate text-xs font-normal text-muted-foreground">
                      {account.description}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {account.tokenPrefix}…
                  </code>
                </TableCell>
                <TableCell
                  className="max-w-[280px] truncate text-muted-foreground"
                  title={account.permissions.join(", ")}
                >
                  {permissionsSummary(account.permissions)}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {account.lastUsedAt
                    ? relative(account.lastUsedAt)
                    : t("serviceAccounts.never")}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={STATUS_TONE[status]}>
                    {t(`serviceAccounts.status.${status}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-right">
                  {!canManage ? null : account.systemManaged ? (
                    // Engine-owned: no edit / rotate / revoke. A locked indicator, not an action menu.
                    <span
                      className="inline-flex size-7 items-center justify-center text-muted-foreground"
                      title={t("serviceAccounts.systemManaged.locked")}
                      aria-label={t("serviceAccounts.systemManaged.locked")}
                    >
                      <LockClosedIcon className="size-4" />
                    </span>
                  ) : isRevoked ? (
                    <RestoreRowAction
                      onRestore={() => handleRestore(account)}
                      disabled={
                        restore.isPending && restore.variables === account.id
                      }
                    />
                  ) : (
                    <ServiceAccountRowActions
                      onEdit={() => openEdit(account)}
                      onRotate={() => setRotating(account)}
                      onRevoke={() => setRevoking(account)}
                      onTest={() => setTesting(account)}
                      editLabel={tc("edit")}
                      testLabel={t("serviceAccounts.rowActions.testIt")}
                      rotateLabel={t("serviceAccounts.rowActions.rotateToken")}
                      revokeLabel={t("serviceAccounts.rowActions.revoke")}
                      openActionsLabel={t("serviceAccounts.rowActions.openActions")}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </ResourceTable>
      )}

      <ServiceAccountFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        account={editing}
      />

      {rotating ? (
        <RotateDialog
          open
          onOpenChange={(open) => {
            if (!open) setRotating(undefined);
          }}
          account={rotating}
        />
      ) : null}

      {revoking ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(undefined);
          }}
          entityKey="serviceAccount"
          name={revoking.name}
          onConfirm={() => revoke.mutateAsync(revoking.id)}
        >
          {t("serviceAccounts.revokeExplanation")}
        </DeleteConfirmDialog>
      ) : null}

      {testing ? (
        <TestItDialog
          account={testing}
          open
          onOpenChange={(open) => {
            if (!open) setTesting(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Per-row actions for a LIVE service account: Edit, Rotate token, and the destructive Revoke. A
 * bespoke menu (not the shared `RowActions`) because Rotate is specific to service accounts — but it
 * mirrors the same dropdown shell, icons and destructive separator so it reads identically. The
 * archived view uses {@link RestoreRowAction} instead, so this only renders for non-revoked rows.
 */
function ServiceAccountRowActions({
  onEdit,
  onRotate,
  onRevoke,
  onTest,
  editLabel,
  testLabel,
  rotateLabel,
  revokeLabel,
  openActionsLabel,
}: {
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
  onTest: () => void;
  editLabel: string;
  testLabel: string;
  rotateLabel: string;
  revokeLabel: string;
  openActionsLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={openActionsLabel}>
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* Dialogs open via page state (siblings of the menu), not nested here. */}
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onTest}>
          <BeakerIcon />
          {testLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <PencilSquareIcon />
          {editLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRotate}>
          <ArrowPathIcon />
          {rotateLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
          <TrashIcon />
          {revokeLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
