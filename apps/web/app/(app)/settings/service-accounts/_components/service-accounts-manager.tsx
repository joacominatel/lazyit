"use client";

import {
  ArrowPathIcon,
  BeakerIcon,
  EllipsisVerticalIcon,
  KeyIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ServiceAccount } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useReducer, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ErrorState, RestoreRowAction } from "@/components/resource-table";
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
import { notifyError } from "@/lib/api/notify-error";
import {
  useRestoreServiceAccount,
  useRevokeServiceAccount,
  useServiceAccounts,
} from "@/lib/api/hooks/use-service-accounts";
import { useCan } from "@/lib/hooks/use-permissions";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { permissionLabel } from "../../_lib/permission-labels";
import { AiAccessDialog } from "./ai-access-dialog";
import { RotateDialog } from "./rotate-dialog";
import { ServiceAccountFormDialog } from "./service-account-form-dialog";
import {
  lifecycleCell,
  permissionChips,
  serviceAccountStatus,
  STATUS_TONE,
} from "./service-account-status";
import { TestItDialog } from "./test-it-dialog";

/** Which dialog / row-action is active. Each modal renders independently from its own field. */
type DialogState = {
  formOpen: boolean;
  editing: ServiceAccount | undefined;
  rotating: ServiceAccount | undefined;
  revoking: ServiceAccount | undefined;
  testing: ServiceAccount | undefined;
  aiAccess: ServiceAccount | undefined;
};

type DialogAction =
  | { type: "createOpened" }
  | { type: "editOpened"; account: ServiceAccount }
  | { type: "formOpenChanged"; open: boolean }
  | { type: "rotatingChanged"; account: ServiceAccount | undefined }
  | { type: "revokingChanged"; account: ServiceAccount | undefined }
  | { type: "testingChanged"; account: ServiceAccount | undefined }
  | { type: "aiAccessChanged"; account: ServiceAccount | undefined };

const INITIAL_DIALOG: DialogState = {
  formOpen: false,
  editing: undefined,
  rotating: undefined,
  revoking: undefined,
  testing: undefined,
  aiAccess: undefined,
};

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "createOpened":
      return { ...state, editing: undefined, formOpen: true };
    case "editOpened":
      return { ...state, editing: action.account, formOpen: true };
    case "formOpenChanged":
      return { ...state, formOpen: action.open };
    case "rotatingChanged":
      return { ...state, rotating: action.account };
    case "revokingChanged":
      return { ...state, revoking: action.account };
    case "testingChanged":
      return { ...state, testing: action.account };
    case "aiAccessChanged":
      return { ...state, aiAccess: action.account };
  }
}

/**
 * The Service Accounts admin list (ADR-0048). A compact list (#1540) of the instance's non-human
 * credentials — name and token prefix, permission chips (the rest collapse into "+N"), last used, and
 * when it expires or why it no longer works — with row actions (Test / Edit / Rotate / AI access /
 * Revoke), a "Show revoked" toggle that switches to the archived (`includeRevoked`) view with per-row
 * Restore, and a create flow that ends in the one-time secret reveal. Empty is one line with the
 * create button. Everything writes through `settings:manage`-gated endpoints — the screen lives behind the
 * AdminGate and re-checks `can('settings:manage')` here so a non-holder sees a read-only list.
 */
export function ServiceAccountsManager() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { relative, date } = useFormatters();
  // A render-stable "now" so the status/expiry derivation (serviceAccountStatus) stays pure.
  const [now] = useState(() => Date.now());
  const [showRevoked, setShowRevoked] = useState(false);
  const { data, isLoading, isError, error, refetch } =
    useServiceAccounts(showRevoked);

  const canManage = useCan("settings:manage");

  const revoke = useRevokeServiceAccount();
  const restore = useRestoreServiceAccount();

  // Which dialog / row-action is active — grouped into one machine (see `dialogReducer`). Destructured
  // into consts so each stays narrowable inside the dialog render closures below.
  const [dialog, dispatchDialog] = useReducer(dialogReducer, INITIAL_DIALOG);
  const { formOpen, editing, rotating, revoking, testing, aiAccess } = dialog;

  const accounts = data ?? [];
  const hasData = accounts.length > 0;

  function openCreate() {
    dispatchDialog({ type: "createOpened" });
  }

  function openEdit(account: ServiceAccount) {
    dispatchDialog({ type: "editOpened", account });
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
        {/* Empty, the one-line empty state carries the create button instead. */}
        {canManage && !showRevoked && hasData ? (
          <Button onClick={openCreate} size="sm">
            <PlusIcon />
            {t("serviceAccounts.newAccount")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-px overflow-hidden rounded-xl ring-1 ring-foreground/10">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 bg-card px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title={t("serviceAccounts.loadError")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <KeyIcon className="size-4 shrink-0" aria-hidden />
            {showRevoked
              ? t("serviceAccounts.empty.revokedTitle")
              : t("serviceAccounts.empty.title")}
          </p>
          {canManage && !showRevoked ? (
            <Button size="sm" onClick={openCreate}>
              <PlusIcon />
              {t("serviceAccounts.empty.action")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul
          aria-label={t("serviceAccounts.title")}
          className="divide-y overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10"
        >
          {accounts.map((account) => {
            const isRevoked = serviceAccountStatus(account, now) === "revoked";
            const lifecycle = lifecycleCell(account, now);
            const chips = permissionChips(account.permissions);
            return (
              <li
                key={account.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1 basis-48 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{account.name}</span>
                    <code
                      className="font-mono text-xs text-muted-foreground"
                      title={t("serviceAccounts.columns.token")}
                    >
                      {account.tokenPrefix}…
                    </code>
                    {account.systemManaged ? (
                      <StatusBadge tone="info" title={t("serviceAccounts.systemManaged.hint")}>
                        <LockClosedIcon />
                        {t("serviceAccounts.systemManaged.badge")}
                      </StatusBadge>
                    ) : null}
                  </p>
                  {account.description ? (
                    <p className="truncate text-xs text-muted-foreground">{account.description}</p>
                  ) : null}
                </div>

                <ul
                  aria-label={t("serviceAccounts.columns.permissions")}
                  className="flex min-w-0 flex-wrap items-center gap-1"
                >
                  {account.permissions.length === 0 ? (
                    <li className="text-xs text-muted-foreground">
                      {t("serviceAccounts.permissionsSummary.none")}
                    </li>
                  ) : null}
                  {chips.shown.map((permission) => (
                    <li
                      key={permission}
                      className="rounded-md bg-muted px-1.5 py-0.5 text-xs"
                      title={permission}
                    >
                      {permissionLabel(t, permission)}
                    </li>
                  ))}
                  {chips.hidden.length > 0 ? (
                    <li
                      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                      title={chips.hidden.map((p) => permissionLabel(t, p)).join(", ")}
                    >
                      <span aria-hidden>+{chips.hidden.length}</span>
                      <span className="sr-only">
                        {chips.hidden.map((p) => permissionLabel(t, p)).join(", ")}
                      </span>
                    </li>
                  ) : null}
                </ul>

                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
                  <span>
                    {account.lastUsedAt
                      ? t("serviceAccounts.lastUsed", { when: relative(account.lastUsedAt) })
                      : t("serviceAccounts.neverUsed")}
                  </span>
                  {lifecycle.kind === "status" ? (
                    <StatusBadge tone={STATUS_TONE[lifecycle.status]}>
                      {t(`serviceAccounts.status.${lifecycle.status}`)}
                    </StatusBadge>
                  ) : lifecycle.kind === "expires" ? (
                    <span>{t("serviceAccounts.expires", { date: date(lifecycle.at) })}</span>
                  ) : (
                    <span>{t("serviceAccounts.noExpiry")}</span>
                  )}
                </div>

                <div className="flex shrink-0 items-center justify-end">
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
                      disabled={restore.isPending && restore.variables === account.id}
                    />
                  ) : (
                    <ServiceAccountRowActions
                      onEdit={() => openEdit(account)}
                      onRotate={() => dispatchDialog({ type: "rotatingChanged", account })}
                      onRevoke={() => dispatchDialog({ type: "revokingChanged", account })}
                      onTest={() => dispatchDialog({ type: "testingChanged", account })}
                      onAiAccess={() => dispatchDialog({ type: "aiAccessChanged", account })}
                      aiAccessLabel={t("serviceAccounts.rowActions.aiAccess")}
                      editLabel={tc("edit")}
                      testLabel={t("serviceAccounts.rowActions.testIt")}
                      rotateLabel={t("serviceAccounts.rowActions.rotateToken")}
                      revokeLabel={t("serviceAccounts.rowActions.revoke")}
                      openActionsLabel={t("serviceAccounts.rowActions.openActions")}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ServiceAccountFormDialog
        open={formOpen}
        onOpenChange={(open) => dispatchDialog({ type: "formOpenChanged", open })}
        account={editing}
      />

      {rotating ? (
        <RotateDialog
          open
          onOpenChange={(open) => {
            if (!open)
              dispatchDialog({ type: "rotatingChanged", account: undefined });
          }}
          account={rotating}
        />
      ) : null}

      {revoking ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open)
              dispatchDialog({ type: "revokingChanged", account: undefined });
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
            if (!open)
              dispatchDialog({ type: "testingChanged", account: undefined });
          }}
        />
      ) : null}

      {aiAccess ? (
        <AiAccessDialog
          account={aiAccess}
          open
          onOpenChange={(open) => {
            if (!open)
              dispatchDialog({ type: "aiAccessChanged", account: undefined });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Per-row actions for a LIVE service account: Test it, Edit, Rotate token, AI access (ADR-0097 — the
 * per-account AI access setting, `settings:manage` like the rest), and the destructive Revoke. A
 * bespoke menu (not the shared `RowActions`) because Rotate is specific to service accounts — but it
 * mirrors the same dropdown shell, icons and destructive separator so it reads identically. The
 * archived view uses {@link RestoreRowAction} instead, so this only renders for non-revoked rows.
 */
function ServiceAccountRowActions({
  onEdit,
  onRotate,
  onRevoke,
  onTest,
  onAiAccess,
  editLabel,
  testLabel,
  aiAccessLabel,
  rotateLabel,
  revokeLabel,
  openActionsLabel,
}: {
  onEdit: () => void;
  onRotate: () => void;
  onRevoke: () => void;
  onTest: () => void;
  onAiAccess: () => void;
  editLabel: string;
  testLabel: string;
  aiAccessLabel: string;
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
        <DropdownMenuItem onSelect={onAiAccess}>
          <SparklesIcon />
          {aiAccessLabel}
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
