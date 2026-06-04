"use client";

import {
  ArrowPathIcon,
  EllipsisVerticalIcon,
  KeyIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  PERMISSION_META,
  type Permission,
  type ServiceAccount,
} from "@lazyit/shared";
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
import { formatRelativeTime } from "@/lib/utils/format";
import { RotateDialog } from "./rotate-dialog";
import { ServiceAccountFormDialog } from "./service-account-form-dialog";
import {
  serviceAccountStatus,
  STATUS_META,
} from "./service-account-status";

const COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-40" /> },
  {
    key: "token",
    header: "Token",
    skeleton: <Skeleton className="h-4 w-28" />,
  },
  {
    key: "permissions",
    header: "Permissions",
    skeleton: <Skeleton className="h-4 w-44" />,
  },
  {
    key: "lastUsed",
    header: "Last used",
    headClassName: "w-28",
    skeleton: <Skeleton className="h-4 w-16" />,
  },
  {
    key: "status",
    header: "Status",
    headClassName: "w-24",
    skeleton: <Skeleton className="h-5 w-16 rounded-4xl" />,
  },
  {
    key: "actions",
    header: "Actions",
    srOnlyHeader: true,
    headClassName: "w-12 text-right",
    skeleton: <Skeleton className="ml-auto size-7" />,
  },
];

const MAX_PERMISSION_LABELS = 2;

/** A short "3 permissions · View assets, Add & edit assets +1" summary for the table cell. */
function permissionsSummary(permissions: Permission[]): string {
  if (permissions.length === 0) return "None";
  const labels = permissions
    .slice(0, MAX_PERMISSION_LABELS)
    .map((p) => PERMISSION_META[p]?.label ?? p);
  const extra = permissions.length - labels.length;
  const count = `${permissions.length} permission${permissions.length === 1 ? "" : "s"}`;
  const tail = extra > 0 ? `, +${extra} more` : "";
  return `${count} · ${labels.join(", ")}${tail}`;
}

/**
 * The Service Accounts admin list (ADR-0048). A ResourceTable of the instance's non-human credentials
 * with row actions (Edit / Rotate / Revoke), a "Show revoked" toggle that switches to the archived
 * (`includeRevoked`) view with per-row Restore, and a create flow that ends in the one-time secret
 * reveal. Everything writes through `settings:manage`-gated endpoints — the screen lives behind the
 * AdminGate and re-checks `can('settings:manage')` here so a non-holder sees a read-only list.
 */
export function ServiceAccountsManager() {
  // A render-stable "now" so the relative-time and expiry derivations stay pure (react-hooks/purity).
  const [now] = useState(() => Date.now());
  const [showRevoked, setShowRevoked] = useState(false);
  const { data, isLoading, isError, error, refetch } =
    useServiceAccounts(showRevoked);

  const canManage = useCan("settings:manage");

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
      onSuccess: () => toast.success("Service account restored"),
      onError: (err) => notifyError(err, "Couldn't restore service account"),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={showRevoked}
            onCheckedChange={setShowRevoked}
            aria-label="Show revoked service accounts"
          />
          Show revoked
        </label>
        {canManage && !showRevoked ? (
          <Button onClick={openCreate} size="sm">
            <PlusIcon />
            New service account
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
      ) : isError ? (
        <ErrorState
          title="Could not load service accounts"
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={KeyIcon}
          pillar="access"
          title={
            showRevoked
              ? "No revoked service accounts"
              : "No service accounts yet"
          }
          description={
            showRevoked
              ? "Revoked (soft-deleted) accounts appear here and can be restored."
              : "Give a CI runner, script or integration scoped, non-human access to the API — create one and hand it a token instead of a person's login."
          }
          action={
            canManage && !showRevoked
              ? { label: "Create the first one", onClick: openCreate }
              : undefined
          }
        />
      ) : (
        <ResourceTable columns={COLUMNS}>
          {accounts.map((account) => {
            const status = serviceAccountStatus(account, now);
            const statusMeta = STATUS_META[status];
            const isRevoked = status === "revoked";
            return (
              <TableRow key={account.id}>
                <TableCell className="font-medium">
                  {account.name}
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
                    ? formatRelativeTime(account.lastUsedAt, now)
                    : "Never"}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={statusMeta.tone}>
                    {statusMeta.label}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-right">
                  {!canManage ? null : isRevoked ? (
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
          entityLabel="service account"
          name={revoking.name}
          onConfirm={() => revoke.mutateAsync(revoking.id)}
        >
          Its token stops authenticating immediately. You can restore it from the
          &ldquo;Show revoked&rdquo; view (rotate to mint a fresh token).
        </DeleteConfirmDialog>
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
}: {
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open actions">
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* Dialogs open via page state (siblings of the menu), not nested here. */}
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onEdit}>
          <PencilSquareIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRotate}>
          <ArrowPathIcon />
          Rotate token
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
          <TrashIcon />
          Revoke
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
