"use client";

import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import {
  buildDefaultRolePermissions,
  type Capability,
  capabilityIsAboveDefaultTier,
  type EditableRole,
  EDITABLE_ROLES,
  type Permission,
  type PermissionPillar,
  PERMISSION_PRESETS,
  PRESET_BY_ID,
  type PresetId,
  type Role,
  type RolePermissionMatrix,
  UpdateRolePermissionsSchema,
} from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { HelpTip } from "@/components/help-tip";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { SettingsSaveBar } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { notifyError } from "@/lib/api/notify-error";
import {
  usePermissionMatrix,
  useUpdatePermissionMatrix,
} from "@/lib/api/hooks/use-permissions-config";
import { useBeforeUnloadGuard } from "@/lib/hooks/use-before-unload-guard";
import { ROLE_ORDER, useRoleCounts } from "@/lib/hooks/use-role-counts";
import { cn } from "@/lib/utils";
import { AdminGate } from "../../_components/admin-gate";
import {
  capabilityDescription,
  capabilityLabel,
  pillarLabel,
  presetLabel,
} from "../../_lib/permission-labels";
import {
  analyzeSaveDiff,
  capabilitiesForPillar,
  detectPreset,
  type SaveDiff,
  type StagedMatrix,
  toggleCapability,
  togglePermission,
} from "../_lib/permissions-form";
import {
  cellState,
  countMatrixChanges,
  groupSummary,
  MATRIX_PILLARS,
  roleIsDirty,
  stagedFromMatrix,
} from "../_lib/role-matrix";
import { ConsequentialConfirmDialog } from "./consequential-confirm-dialog";
import { FineTune } from "./fine-tune";

/** Badge tone per role (ADR-0040): ADMIN stands out, the editable roles stay neutral. */
const ROLE_TONE: Record<Role, StatusTone> = {
  ADMIN: "info",
  MEMBER: "neutral",
  VIEWER: "neutral",
};

/**
 * Settings → Roles & permissions (#1540): ONE matrix of capabilities (rows, grouped by pillar) × roles
 * (columns). ADMIN is a locked reference column — always every permission (ADR-0046); MEMBER and VIEWER
 * are editable. Each editable column header carries its preset selector and holder count, each group a
 * collapsible header with an n/m summary per column.
 *
 * Both editable roles are staged together and saved together — `PUT /config/permissions` replaces the
 * whole `{ MEMBER, VIEWER }` matrix — through ONE save bar ("Save N changes"). A consequential save (a
 * removed read, or a newly granted admin-level permission, on either role) routes through the same
 * confirmation as before; any other save goes straight through. Fine-tune (every raw permission, per
 * role) stays below the matrix.
 */
function RolesMatrix() {
  const t = useTranslations("settings");
  const matrixQuery = usePermissionMatrix();
  const { counts, isLoading: countsLoading } = useRoleCounts();
  const updateMutation = useUpdatePermissionMatrix();

  // Both editable roles' staged sets, null until the server matrix arrives (never a default form).
  const [staged, setStaged] = useState<StagedMatrix | null>(null);
  // Re-seed during render whenever the query hands back a NEW matrix object (a refetch after save):
  // the "reset state when a prop changes" pattern, no effect.
  const [seededFrom, setSeededFrom] = useState<RolePermissionMatrix | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<SaveDiff | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<PermissionPillar>>(
    () => new Set(MATRIX_PILLARS.slice(1)),
  );

  const serverMatrix = matrixQuery.data;
  if (serverMatrix && serverMatrix !== seededFrom) {
    setSeededFrom(serverMatrix);
    setStaged(stagedFromMatrix(serverMatrix));
  }

  const changeCount = staged && serverMatrix ? countMatrixChanges(serverMatrix, staged) : 0;
  const dirty = changeCount > 0;
  useBeforeUnloadGuard(dirty);

  const stagedSets = useMemo<Record<EditableRole, ReadonlySet<Permission>>>(
    () => ({
      MEMBER: new Set(staged?.MEMBER ?? []),
      VIEWER: new Set(staged?.VIEWER ?? []),
    }),
    [staged],
  );
  const serverSets = useMemo<Record<EditableRole, ReadonlySet<Permission>>>(
    () => ({
      MEMBER: new Set(serverMatrix?.MEMBER ?? []),
      VIEWER: new Set(serverMatrix?.VIEWER ?? []),
    }),
    [serverMatrix],
  );

  const setRole = useCallback((role: EditableRole, next: Permission[]) => {
    setStaged((prev) => (prev ? { ...prev, [role]: next } : prev));
  }, []);

  const applyPreset = (role: EditableRole, presetId: PresetId) =>
    setRole(role, [...PRESET_BY_ID[presetId].permissions]);

  const onToggleCapability = (role: EditableRole, capability: Capability, on: boolean) => {
    if (!staged) return;
    setRole(role, toggleCapability(capability, staged[role], on));
  };

  const onTogglePermission = (role: EditableRole, permission: Permission, on: boolean) => {
    if (!staged) return;
    setRole(role, togglePermission(permission, staged[role], on));
  };

  const resetToDefaults = () => setStaged(stagedFromMatrix(buildDefaultRolePermissions()));

  const discard = () => {
    if (serverMatrix) setStaged(stagedFromMatrix(serverMatrix));
  };

  const toggleGroup = (pillar: PermissionPillar) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pillar)) next.delete(pillar);
      else next.add(pillar);
      return next;
    });

  // ── Save flow (unchanged rules: validate the full body, confirm only a consequential diff) ─────────
  const doSave = useCallback(async () => {
    if (!staged) return;
    const parsed = UpdateRolePermissionsSchema.safeParse({
      MEMBER: staged.MEMBER,
      VIEWER: staged.VIEWER,
    });
    if (!parsed.success) {
      toast.error(t("roles.permissions.toast.invalid"), {
        description: t("roles.permissions.toast.invalidHint"),
      });
      return;
    }
    try {
      await updateMutation.mutateAsync(parsed.data);
      toast.success(t("roles.permissions.toast.saved"));
      setConfirmOpen(false);
      setPendingDiff(null);
    } catch (error) {
      notifyError(error, t("roles.permissions.toast.saveError"));
    }
  }, [staged, updateMutation, t]);

  const onSave = () => {
    if (!staged || !serverMatrix) return;
    const diffs = EDITABLE_ROLES.map((role) =>
      analyzeSaveDiff(role, serverMatrix[role] ?? [], staged[role], t),
    );
    const combined: SaveDiff = {
      removedReads: diffs.flatMap((d) => d.removedReads),
      aboveTierGrants: diffs.flatMap((d) => d.aboveTierGrants),
      isConsequential: diffs.some((d) => d.isConsequential),
    };
    if (combined.isConsequential) {
      setPendingDiff(combined);
      setConfirmOpen(true);
      return;
    }
    void doSave();
  };

  if (matrixQuery.isError) {
    return (
      <ErrorState
        title={t("roles.permissions.loadError")}
        onRetry={() => void matrixQuery.refetch()}
        error={matrixQuery.error}
      />
    );
  }
  if (matrixQuery.isLoading || !staged || !serverMatrix) {
    return <MatrixSkeleton />;
  }

  const roleLabel = (role: Role) => t(`roles.meta.${role}.label`);

  return (
    <div className="space-y-4 pb-8">
      <PageHeader
        title={t("roles.title")}
        subtitle={t("roles.subtitle")}
        badge={
          <HelpTip topic={t("roles.title")} href="/help/users-permissions-permission-configuration">
            <p>{t("roles.permissions.idpNote")}</p>
            <ul className="space-y-1">
              {ROLE_ORDER.map((role) => (
                <li key={role}>
                  <span className="font-medium">{roleLabel(role)}</span> —{" "}
                  {t(`roles.meta.${role}.hint`)}
                </li>
              ))}
            </ul>
          </HelpTip>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={resetToDefaults}>
              <ArrowUturnLeftIcon />
              {t("roles.matrix.reset")}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/users">
                {t("roles.manageUsers")}
                <ArrowTopRightOnSquareIcon />
              </Link>
            </Button>
          </>
        }
      />

      <section
        aria-label={t("roles.matrix.ariaLabel")}
        className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10"
      >
        {/* The matrix scrolls inside its own box on a narrow screen; the page never does. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th
                  scope="col"
                  className="sticky left-0 z-10 bg-card px-4 py-3 text-left align-bottom text-xs font-medium text-muted-foreground"
                >
                  {t("roles.matrix.capability")}
                </th>
                {ROLE_ORDER.map((role) => {
                  const editable = role !== "ADMIN";
                  const count = counts?.[role];
                  return (
                    <th
                      key={role}
                      scope="col"
                      className="w-36 border-l px-2 py-3 text-center align-top font-normal"
                    >
                      <div className="flex flex-col items-center gap-1.5">
                        <span className="flex items-center gap-1.5">
                          <StatusBadge tone={ROLE_TONE[role]}>{roleLabel(role)}</StatusBadge>
                          {editable && roleIsDirty(role, serverMatrix, staged) ? (
                            <StatusDot
                              tone="warning"
                              role="img"
                              aria-hidden={false}
                              aria-label={t("roles.matrix.roleUnsaved")}
                            />
                          ) : null}
                        </span>
                        {countsLoading ? (
                          <Skeleton className="h-4 w-14" />
                        ) : (
                          <Link
                            href={`/users?role=${role}`}
                            className="font-mono text-xs text-muted-foreground tabular-nums underline-offset-4 hover:text-foreground hover:underline"
                          >
                            {t("roles.matrix.members", { count: count ?? 0 })}
                          </Link>
                        )}
                        {editable ? (
                          <PresetSelect
                            role={role}
                            value={detectPreset(staged[role])}
                            onApply={(id) => applyPreset(role, id)}
                          />
                        ) : (
                          <span
                            className="inline-flex h-7 items-center gap-1 text-xs text-muted-foreground"
                            title={t("roles.matrix.adminLocked")}
                          >
                            <LockClosedIcon className="size-3.5" aria-hidden />
                            {t("roles.matrix.all")}
                            <span className="sr-only">{t("roles.matrix.adminLocked")}</span>
                          </span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            {MATRIX_PILLARS.map((pillar) => {
              const capabilities = capabilitiesForPillar(pillar);
              const open = !collapsed.has(pillar);
              const label = pillarLabel(t, pillar);
              return (
                <tbody key={pillar} className="border-b last:border-b-0">
                  <tr className="bg-muted">
                    <th
                      scope="rowgroup"
                      className="sticky left-0 z-10 bg-muted p-0 text-left"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(pillar)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <ChevronRightIcon
                          className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
                          aria-hidden
                        />
                        {label}
                      </button>
                    </th>
                    {ROLE_ORDER.map((role) => {
                      const summary =
                        role === "ADMIN"
                          ? { granted: capabilities.length, total: capabilities.length }
                          : groupSummary(pillar, stagedSets[role]);
                      return (
                        <td
                          key={role}
                          className="border-l px-2 py-2.5 text-center font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          <span aria-hidden>
                            {summary.granted}/{summary.total}
                          </span>
                          <span className="sr-only">
                            {t("roles.matrix.groupSummary", {
                              granted: summary.granted,
                              total: summary.total,
                              role: roleLabel(role),
                            })}
                          </span>
                        </td>
                      );
                    })}
                  </tr>

                  {open
                    ? capabilities.map((capability) => (
                        <CapabilityRow
                          key={capability.id}
                          capability={capability}
                          staged={stagedSets}
                          server={serverSets}
                          onToggle={onToggleCapability}
                        />
                      ))
                    : null}
                </tbody>
              );
            })}
          </table>
        </div>

        <SettingsSaveBar
          className="sticky bottom-0 z-20 rounded-b-xl bg-card"
          note={
            <span aria-live="polite">
              {dirty
                ? t("roles.matrix.unsaved", { count: changeCount })
                : t("roles.matrix.noChanges")}
            </span>
          }
        >
          {dirty ? (
            <Button variant="ghost" onClick={discard} disabled={updateMutation.isPending}>
              {t("roles.matrix.discard")}
            </Button>
          ) : null}
          <Button onClick={onSave} disabled={!dirty || updateMutation.isPending}>
            {updateMutation.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("roles.matrix.save", { count: changeCount })}
          </Button>
        </SettingsSaveBar>
      </section>

      <FineTune staged={stagedSets} onToggle={onTogglePermission} />

      {pendingDiff && (
        <ConsequentialConfirmDialog
          open={confirmOpen}
          onOpenChange={(next) => {
            setConfirmOpen(next);
            if (!next) setPendingDiff(null);
          }}
          diff={pendingDiff}
          onConfirm={doSave}
          isPending={updateMutation.isPending}
        />
      )}
    </div>
  );
}

/** One capability row: its label (+ "?" description, ⚠ when admin-level) and a cell per role. */
function CapabilityRow({
  capability,
  staged,
  server,
  onToggle,
}: {
  capability: Capability;
  staged: Record<EditableRole, ReadonlySet<Permission>>;
  server: Record<EditableRole, ReadonlySet<Permission>>;
  onToggle: (role: EditableRole, capability: Capability, on: boolean) => void;
}) {
  const t = useTranslations("settings");
  const label = capabilityLabel(t, capability.id);
  return (
    <tr className="border-t">
      <th
        scope="row"
        className="sticky left-0 z-10 bg-card px-4 py-2 text-left font-normal"
      >
        <span className="flex items-center gap-0.5">
          <span className="min-w-0">{label}</span>
          <HelpTip topic={label}>
            <p>{capabilityDescription(t, capability.id)}</p>
          </HelpTip>
          {capabilityIsAboveDefaultTier(capability) ? (
            <HelpTip
              topic={t("roles.matrix.adminLevelTopic", { capability: label })}
              icon={<ExclamationTriangleIcon className="size-4 text-warning-text" aria-hidden />}
            >
              <p>{t("roles.matrix.adminLevelHelp")}</p>
            </HelpTip>
          ) : null}
        </span>
      </th>
      {ROLE_ORDER.map((role) => {
        if (role === "ADMIN") {
          return (
            <td key={role} className="border-l px-2 py-2 text-center">
              <CheckIcon className="mx-auto size-4 text-muted-foreground" aria-hidden />
              <span className="sr-only">{t("roles.matrix.granted")}</span>
            </td>
          );
        }
        const state = cellState(capability, staged[role]);
        const changed = capability.permissions.some(
          (p) => staged[role].has(p) !== server[role].has(p),
        );
        return (
          <td
            key={role}
            className={cn("border-l px-2 py-2 text-center", changed && "bg-warning/10")}
          >
            <span
              className="inline-flex size-6 items-center justify-center"
              title={state === "partial" ? t("roles.matrix.partial") : undefined}
            >
              <Checkbox
                checked={state === "on" ? true : state === "partial" ? "indeterminate" : false}
                onCheckedChange={(next) => onToggle(role, capability, next === true)}
                aria-label={t("roles.matrix.cellLabel", {
                  capability: label,
                  role: t(`roles.meta.${role}.label`),
                })}
              />
            </span>
            {state === "partial" ? (
              <span className="sr-only">{t("roles.matrix.partial")}</span>
            ) : null}
          </td>
        );
      })}
    </tr>
  );
}

/** The preset selector in an editable role's column header. "Custom" is a state, not a choice. */
function PresetSelect({
  role,
  value,
  onApply,
}: {
  role: EditableRole;
  value: PresetId | "custom";
  onApply: (id: PresetId) => void;
}) {
  const t = useTranslations("settings");
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== "custom") onApply(next as PresetId);
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-full max-w-32 text-xs"
        aria-label={t("roles.matrix.presetLabel", { role: t(`roles.meta.${role}.label`) })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERMISSION_PRESETS.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {presetLabel(t, preset.id)}
          </SelectItem>
        ))}
        <SelectItem value="custom" disabled>
          {t("roles.permissions.preset.custom")}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function MatrixSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-[28rem] w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

/**
 * The Roles & permissions page body (client). The page prefetches the matrix
 * (`permissionConfigKeys.matrix()`) so `usePermissionMatrix()` hydrates without a waterfall. Behind the
 * same `AdminGate` as the rest of Settings — the API's `settings:manage` guard is the real boundary.
 */
export function RolesMatrixView() {
  return (
    <AdminGate>
      <RolesMatrix />
    </AdminGate>
  );
}
