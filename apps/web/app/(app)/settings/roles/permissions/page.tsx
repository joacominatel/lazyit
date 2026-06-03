"use client";

import {
  ArrowUturnLeftIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import {
  buildDefaultRolePermissions,
  type Capability,
  type EditableRole,
  EDITABLE_ROLES,
  type Permission,
  PRESET_BY_ID,
  type PresetId,
  type Role,
  type RolePermissionMatrix,
  UpdateRolePermissionsSchema,
} from "@lazyit/shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePermissionMatrix,
  useUpdatePermissionMatrix,
} from "@/lib/api/hooks/use-permissions-config";
import { useBeforeUnloadGuard } from "@/lib/hooks/use-before-unload-guard";
import { useUsersByRole } from "@/lib/hooks/use-users-by-role";
import { AdminGate } from "../../_components/admin-gate";
import { CapabilityGroup } from "./_components/capability-group";
import { ConsequentialConfirmDialog } from "./_components/consequential-confirm-dialog";
import { FineTune } from "./_components/fine-tune";
import {
  analyzeSaveDiff,
  detectPreset,
  type SaveDiff,
  type StagedMatrix,
  toggleCapability,
  togglePermission,
} from "./_components/permissions-form";
import { PresetRow } from "./_components/preset-row";
import { RoleSegmented } from "./_components/role-segmented";
import { RoleSummary } from "./_components/role-summary";
import { SaveBar } from "./_components/save-bar";
import { notifyError } from "@/lib/api/notify-error";

const PILLAR_ORDER = ["inventory", "access", "knowledge", "manage"] as const;

/** Parse the `?role=` deep-link to an editable role, defaulting to MEMBER for an absent/bad value. */
function roleFromParam(value: string | null): EditableRole {
  return value === "VIEWER" ? "VIEWER" : "MEMBER";
}

/** Seed both editable roles' staged sets from the server matrix (a fresh, mutable copy). */
function stagedFromMatrix(matrix: RolePermissionMatrix): StagedMatrix {
  return {
    MEMBER: [...(matrix.MEMBER ?? [])],
    VIEWER: [...(matrix.VIEWER ?? [])],
  };
}

function PermissionsEditor() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editingRole = roleFromParam(searchParams.get("role"));

  const matrixQuery = usePermissionMatrix();
  const { byRole } = useUsersByRole();
  const updateMutation = useUpdatePermissionMatrix();

  // The staged sets for BOTH editable roles (held together so editing one never clobbers the other —
  // the PUT replaces both). Null until the server matrix loads, so we never flash a default form.
  const [staged, setStaged] = useState<StagedMatrix | null>(null);
  // The server matrix object we last seeded from. Seeding during render (the React-recommended "reset
  // state when a prop changes" pattern — no effect, no cascading render) keys off this: TanStack
  // returns a NEW matrix object on a successful refetch (after a save invalidates the query), so a
  // save round-trips the form back to the persisted truth automatically.
  const [seededFrom, setSeededFrom] = useState<RolePermissionMatrix | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<SaveDiff | null>(null);

  const serverMatrix = matrixQuery.data;
  if (serverMatrix && serverMatrix !== seededFrom) {
    setSeededFrom(serverMatrix);
    setStaged(stagedFromMatrix(serverMatrix));
  }

  const holderCounts: Record<Role, number> | undefined = useMemo(() => {
    if (!byRole) return undefined;
    return {
      ADMIN: byRole.ADMIN.length,
      MEMBER: byRole.MEMBER.length,
      VIEWER: byRole.VIEWER.length,
    };
  }, [byRole]);

  // Per-role dirtiness (staged vs. server), and whole-form dirtiness.
  const isRoleDirty = useCallback(
    (role: EditableRole): boolean => {
      if (!staged || !serverMatrix) return false;
      const a = [...staged[role]].sort();
      const b = [...(serverMatrix[role] ?? [])].sort();
      return a.length !== b.length || a.some((p, i) => p !== b[i]);
    },
    [staged, serverMatrix],
  );
  const dirty = isRoleDirty("MEMBER") || isRoleDirty("VIEWER");
  useBeforeUnloadGuard(dirty);

  const stagedSet = useMemo<ReadonlySet<Permission>>(
    () => new Set(staged ? staged[editingRole] : []),
    [staged, editingRole],
  );
  const activePreset = useMemo(
    () => detectPreset(staged ? staged[editingRole] : []),
    [staged, editingRole],
  );

  // ── Mutators (all operate on the EDITED role's set; the other role's stays put) ──────────────────
  const setEditedSet = useCallback(
    (next: Permission[]) => {
      setStaged((prev) =>
        prev ? { ...prev, [editingRole]: next } : prev,
      );
    },
    [editingRole],
  );

  const handleSelectRole = (role: EditableRole) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("role", role);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const handleApplyPreset = (presetId: PresetId) => {
    // PRESET_BY_ID is the source of the staged bundle (full set replace).
    setEditedSet([...PRESET_BY_ID[presetId].permissions]);
  };

  const handleToggleCapability = (capability: Capability, on: boolean) => {
    if (!staged) return;
    setEditedSet(toggleCapability(capability, staged[editingRole], on));
  };

  const handleTogglePermission = (permission: Permission, on: boolean) => {
    if (!staged) return;
    setEditedSet(togglePermission(permission, staged[editingRole], on));
  };

  const handleResetDefaults = () => {
    const defaults = buildDefaultRolePermissions();
    setEditedSet([...defaults[editingRole]]);
  };

  const handleDiscard = () => {
    if (serverMatrix) setStaged(stagedFromMatrix(serverMatrix));
  };

  // ── Save flow ────────────────────────────────────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    if (!staged) return;
    const body = { MEMBER: staged.MEMBER, VIEWER: staged.VIEWER };
    // Validate the COMPLETE both-role body with the shared schema before the PUT (catches an unknown
    // literal client-side; the backend re-validates and is the real gate).
    const parsed = UpdateRolePermissionsSchema.safeParse(body);
    if (!parsed.success) {
      toast.error("Some permissions are invalid", {
        description: "Refresh and try again.",
      });
      return;
    }
    try {
      await updateMutation.mutateAsync(parsed.data);
      toast.success("Permissions saved");
      setConfirmOpen(false);
      setPendingDiff(null);
    } catch (error) {
      // The mutation surfaces the API error (400/403) via the shared error toast.
      notifyError(error, "Couldn't save permissions");
    }
  }, [staged, updateMutation]);

  const handleSaveClick = () => {
    if (!staged || !serverMatrix) return;
    // Tiered confirm: only when the diff REMOVES a read or GRANTS an above-tier capability, on EITHER
    // edited role. Combine both roles' diffs so a save that touches the non-active role still warns.
    const diffs = EDITABLE_ROLES.map((role) =>
      analyzeSaveDiff(role, serverMatrix[role] ?? [], staged[role]),
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

  // ── Render ───────────────────────────────────────────────────────────────────────────────────
  if (matrixQuery.isLoading || !staged) {
    return <EditorSkeleton />;
  }
  if (matrixQuery.isError) {
    return (
      <ErrorState
        title="Couldn't load permissions"
        onRetry={() => void matrixQuery.refetch()}
        error={matrixQuery.error}
      />
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Role permissions"
        subtitle="Configure what Members and Viewers can do. Admin always has full access."
        breadcrumb={<Breadcrumb />}
      />

      <p className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
        <InformationCircleIcon className="mt-0.5 size-4 shrink-0" />
        These permissions are lazyit-only — they never appear in your identity
        provider.
      </p>

      <RoleSegmented
        value={editingRole}
        onChange={handleSelectRole}
        counts={holderCounts}
        isDirty={isRoleDirty}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Start from a preset</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetDefaults}
                >
                  <ArrowUturnLeftIcon className="size-4" />
                  Reset to defaults
                </Button>
              </div>
              <PresetRow active={activePreset} onApply={handleApplyPreset} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-6 pt-5">
              <h2 className="text-sm font-semibold">Capabilities</h2>
              {PILLAR_ORDER.map((pillar) => (
                <CapabilityGroup
                  key={pillar}
                  pillar={pillar}
                  staged={stagedSet}
                  onToggle={handleToggleCapability}
                />
              ))}
            </CardContent>
          </Card>

          <FineTune staged={stagedSet} onToggle={handleTogglePermission} />
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardContent className="pt-5">
              <RoleSummary staged={stagedSet} />
            </CardContent>
          </Card>
        </aside>
      </div>

      <SaveBar
        dirty={dirty}
        isSaving={updateMutation.isPending}
        onDiscard={handleDiscard}
        onSave={handleSaveClick}
      />

      {pendingDiff && (
        <ConsequentialConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            setConfirmOpen(open);
            if (!open) setPendingDiff(null);
          }}
          diff={pendingDiff}
          onConfirm={doSave}
          isPending={updateMutation.isPending}
        />
      )}
    </div>
  );
}

/** Skeleton shown while the matrix loads — never a default-checked editable form. */
function EditorSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-10 w-72 rounded-lg" />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Settings → Roles → Role permissions (RBAC v2 P7, ADR-0046). The ADMIN-only screen to configure what
 * MEMBER and VIEWER can do: a role picker (ADMIN locked), one-click presets, plain-language capability
 * toggles grouped by pillar, an advanced fine-tune disclosure, a live "what this role can do" summary
 * and a sticky save bar. Consequential saves (a removed read or an above-tier grant) route through a
 * neutral-tone confirm. ADMIN is immutable/full and is never editable here.
 *
 * Wrapped in AdminGate (the same client gate as the rest of Settings — the API's `settings:manage`
 * guard is the real boundary) and in Suspense (the `?role=` deep-link reads `useSearchParams`).
 */
export default function RolePermissionsPage() {
  return (
    <AdminGate>
      <Suspense fallback={<EditorSkeleton />}>
        <PermissionsEditor />
      </Suspense>
    </AdminGate>
  );
}
