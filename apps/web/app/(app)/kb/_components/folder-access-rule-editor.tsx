"use client";

import {
  ArrowPathIcon,
  GlobeAltIcon,
  LockClosedIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  type FolderAccessRule,
  type FolderAccessRules,
  isPublicAccessRules,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useSetFolderAccessRules } from "@/lib/api/hooks/use-folder-access-rules";
import { useUsers } from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";

/**
 * The folder's `accessRules` as returned by the API — the `ArticleCategory` row includes this
 * `Json?` column that the shared `ArticleCategorySchema` doesn't validate (it's a jsonb Prisma
 * field). We treat it as an opaque value here and hand it to `isPublicAccessRules`. The editor
 * never crafts rules from the raw value — it works from a local copy the admin sets explicitly.
 */
export type RawAccessRules = FolderAccessRules | unknown;

/**
 * FolderAccessRuleEditor — the compact ADMIN-only panel for viewing and editing a folder's
 * access rules (ADR-0060 §3). Gated by `settings:manage` client-side (the API enforces it
 * server-side as the real boundary — INV-9).
 *
 * The editor is a calm, deliberate UI: PUBLIC is the quiet default and the only path that asks
 * zero decisions. Adding a restriction is an explicit, labeled action. Each rule in the OR-set
 * is shown as a removable row; the "Add rule" picker stays visually subordinate until invoked.
 *
 * Rule vocabulary (closed set, ADR-0060 §3):
 *   - users      — explicit named users (multi-pick, one "users" rule per editor session)
 *   - role       — all holders of a given RBAC role
 *   - appGrant   — active AccessGrant holders for a specific application
 *   - assetAssignment — current assignees of a specific asset
 */
export function FolderAccessRuleEditor({
  folderId,
  folderName,
  rawAccessRules,
}: {
  folderId: string;
  folderName: string;
  /** The `accessRules` value from the API response — may be null/undefined (= PUBLIC). */
  rawAccessRules: RawAccessRules;
}) {
  const t = useTranslations("kb");

  // Parse the raw access rules from the API response into the typed vocabulary. The API stores
  // these as validated jsonb (the backend uses `UpdateFolderAccessRulesSchema`), so a simple
  // cast is safe; we still guard with isPublicAccessRules to handle null/empty cleanly.
  const initialRules: FolderAccessRules = useMemo(() => {
    if (isPublicAccessRules(rawAccessRules as FolderAccessRules)) return null;
    return rawAccessRules as FolderAccessRules;
  }, [rawAccessRules]);

  const [rules, setRules] = useState<FolderAccessRules>(initialRules);
  const [dirty, setDirty] = useState(false);

  const setAccessRules = useSetFolderAccessRules();

  const isPublic = isPublicAccessRules(rules);

  // Supporting data for the pickers — all loaded from existing hooks (no new endpoints).
  const { data: users } = useUsers();
  const { data: applications } = useApplications();
  const { data: assetsPage } = useAssets({ limit: 200 });
  const assets = assetsPage?.items ?? [];

  // A stable lookup map to resolve ids to display names in the rendered rule rows.
  const userById = useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u])),
    [users],
  );
  const appById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a])),
    [applications],
  );
  const assetById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets],
  );

  // ------------------------------------------------------------------ mutations

  const handleSave = useCallback(() => {
    setAccessRules.mutate(
      { id: folderId, accessRules: rules },
      {
        onSuccess: () => {
          toast.success(t("access.toast.saved"));
          setDirty(false);
        },
        onError: (err) => notifyError(err, t("access.toast.saveError")),
      },
    );
  }, [folderId, rules, setAccessRules, t]);

  const handleMakePublic = useCallback(() => {
    setRules(null);
    setDirty(true);
  }, []);

  const removeRule = useCallback((index: number) => {
    setRules((prev) => {
      const next = (prev ?? []).filter((_, i) => i !== index);
      return next.length === 0 ? null : next;
    });
    setDirty(true);
  }, []);

  const addRule = useCallback((rule: FolderAccessRule) => {
    setRules((prev) => [...(prev ?? []), rule]);
    setDirty(true);
  }, []);

  // ------------------------------------------------------------------ render

  return (
    <div className="space-y-3">
      {/* Access state header */}
      <div className="flex items-center gap-2">
        {isPublic ? (
          <GlobeAltIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <LockClosedIcon className="size-4 shrink-0 text-warning" aria-hidden />
        )}
        <span className="text-sm font-medium">
          {isPublic ? t("access.statePublic") : t("access.stateRestricted")}
        </span>
        {!isPublic && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleMakePublic}
            disabled={setAccessRules.isPending}
            className="ml-auto"
          >
            <GlobeAltIcon className="size-3.5" />
            {t("access.makePublic")}
          </Button>
        )}
      </div>

      {/* Public description */}
      {isPublic ? (
        <p className="text-xs text-muted-foreground">
          {t("access.publicHint")}
        </p>
      ) : null}

      {/* OR-rule list */}
      {!isPublic && rules && rules.length > 0 ? (
        <ul className="space-y-1.5">
          {rules.map((rule, index) => (
            <RuleRow
              key={index}
              rule={rule}
              userById={userById}
              appById={appById}
              assetById={assetById}
              onRemove={() => removeRule(index)}
              disabled={setAccessRules.isPending}
              t={t}
            />
          ))}
        </ul>
      ) : null}

      {/* Add-rule picker */}
      {(rules?.length ?? 0) < 20 ? (
        <>
          {!isPublic && <Separator className="my-2" />}
          <AddRuleRow
            existingRules={rules ?? []}
            users={users ?? []}
            applications={applications ?? []}
            assets={assets}
            onAdd={addRule}
            disabled={setAccessRules.isPending}
            t={t}
          />
        </>
      ) : null}

      {/* Save / discard footer — only shown when the user has made changes */}
      {dirty ? (
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={setAccessRules.isPending}
          >
            {setAccessRules.isPending ? (
              <ArrowPathIcon className="animate-spin" />
            ) : null}
            {t("access.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setRules(initialRules);
              setDirty(false);
            }}
            disabled={setAccessRules.isPending}
          >
            {t("access.discard")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Rule row — one rendered rule in the OR-set

type RuleRowProps = {
  rule: FolderAccessRule;
  userById: Map<string, { id: string; firstName: string; lastName: string }>;
  appById: Map<string, { id: string; name: string }>;
  assetById: Map<string, { id: string; name: string }>;
  onRemove: () => void;
  disabled: boolean;
  t: ReturnType<typeof useTranslations<"kb">>;
};

function RuleRow({
  rule,
  userById,
  appById,
  assetById,
  onRemove,
  disabled,
  t,
}: RuleRowProps) {
  const label = ruleLabel(rule, userById, appById, assetById, t);

  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
      <RuleKindBadge kind={rule.kind} t={t} />
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("access.removeRuleAriaLabel")}
        onClick={onRemove}
        disabled={disabled}
        className="ml-auto shrink-0"
      >
        <XMarkIcon />
      </Button>
    </li>
  );
}

function RuleKindBadge({
  kind,
  t,
}: {
  kind: FolderAccessRule["kind"];
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const kindKeys: Record<FolderAccessRule["kind"], string> = {
    users: "access.kindUsers",
    role: "access.kindRole",
    appGrant: "access.kindAppGrant",
    assetAssignment: "access.kindAssetAssignment",
  };
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
      {t(kindKeys[kind] as Parameters<typeof t>[0])}
    </span>
  );
}

function ruleLabel(
  rule: FolderAccessRule,
  userById: Map<string, { firstName: string; lastName: string }>,
  appById: Map<string, { name: string }>,
  assetById: Map<string, { name: string }>,
  t: ReturnType<typeof useTranslations<"kb">>,
): string {
  switch (rule.kind) {
    case "users": {
      const names = rule.userIds.map((id) => {
        const u = userById.get(id);
        return u ? `${u.firstName} ${u.lastName}` : id;
      });
      return names.join(", ");
    }
    case "role":
      return t(`access.roleLabel.${rule.role}` as Parameters<typeof t>[0]);
    case "appGrant": {
      const app = appById.get(rule.applicationId);
      return app?.name ?? rule.applicationId;
    }
    case "assetAssignment": {
      const asset = assetById.get(rule.assetId);
      return asset?.name ?? rule.assetId;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Add-rule row — a two-step picker: choose kind, then choose the subject

type User = { id: string; firstName: string; lastName: string };
type Application = { id: string; name: string };
type AssetItem = { id: string; name: string };

type AddRuleRowProps = {
  existingRules: FolderAccessRule[];
  users: User[];
  applications: Application[];
  assets: AssetItem[];
  onAdd: (rule: FolderAccessRule) => void;
  disabled: boolean;
  t: ReturnType<typeof useTranslations<"kb">>;
};

type RuleKind = FolderAccessRule["kind"];

function AddRuleRow({
  existingRules,
  users,
  applications,
  assets,
  onAdd,
  disabled,
  t,
}: AddRuleRowProps) {
  const [kind, setKind] = useState<RuleKind | "">("");
  // Subject selectors for each kind
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>("");
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");

  // Already-picked roles and app/asset ids — used to disable already-added options.
  const existingRoles = useMemo(
    () =>
      new Set(
        existingRules.flatMap((r) => (r.kind === "role" ? [r.role] : [])),
      ),
    [existingRules],
  );
  const existingAppIds = useMemo(
    () =>
      new Set(
        existingRules.flatMap((r) =>
          r.kind === "appGrant" ? [r.applicationId] : [],
        ),
      ),
    [existingRules],
  );
  const existingAssetIds = useMemo(
    () =>
      new Set(
        existingRules.flatMap((r) =>
          r.kind === "assetAssignment" ? [r.assetId] : [],
        ),
      ),
    [existingRules],
  );

  function resetSubject() {
    setSelectedUserIds([]);
    setSelectedRole("");
    setSelectedAppId("");
    setSelectedAssetId("");
  }

  function handleKindChange(value: string) {
    setKind(value as RuleKind | "");
    resetSubject();
  }

  function handleAdd() {
    if (!kind) return;

    let rule: FolderAccessRule | null = null;

    switch (kind) {
      case "users":
        if (selectedUserIds.length === 0) return;
        rule = { kind: "users", userIds: selectedUserIds };
        break;
      case "role":
        if (!selectedRole) return;
        rule = { kind: "role", role: selectedRole as "ADMIN" | "MEMBER" | "VIEWER" };
        break;
      case "appGrant":
        if (!selectedAppId) return;
        rule = { kind: "appGrant", applicationId: selectedAppId };
        break;
      case "assetAssignment":
        if (!selectedAssetId) return;
        rule = { kind: "assetAssignment", assetId: selectedAssetId };
        break;
    }

    if (!rule) return;
    onAdd(rule);
    setKind("");
    resetSubject();
  }

  const canAdd =
    kind === "users"
      ? selectedUserIds.length > 0
      : kind === "role"
        ? Boolean(selectedRole)
        : kind === "appGrant"
          ? Boolean(selectedAppId)
          : kind === "assetAssignment"
            ? Boolean(selectedAssetId)
            : false;

  return (
    <div className="space-y-2">
      {/* Kind selector */}
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={handleKindChange} disabled={disabled}>
          <SelectTrigger
            size="sm"
            className={cn("flex-1", !kind && "text-muted-foreground")}
            aria-label={t("access.addRuleKindLabel")}
          >
            <SelectValue placeholder={t("access.addRulePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="users">{t("access.kindUsers")}</SelectItem>
            <SelectItem value="role">{t("access.kindRole")}</SelectItem>
            <SelectItem value="appGrant">{t("access.kindAppGrant")}</SelectItem>
            <SelectItem value="assetAssignment">
              {t("access.kindAssetAssignment")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Subject selector — rendered after a kind is chosen */}
      {kind === "users" ? (
        <UserMultiPick
          users={users}
          selected={selectedUserIds}
          onChange={setSelectedUserIds}
          disabled={disabled}
          t={t}
        />
      ) : kind === "role" ? (
        <Select
          value={selectedRole}
          onValueChange={setSelectedRole}
          disabled={disabled}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={t("access.selectRole")} />
          </SelectTrigger>
          <SelectContent>
            {(["ADMIN", "MEMBER", "VIEWER"] as const).map((role) => (
              <SelectItem
                key={role}
                value={role}
                disabled={existingRoles.has(role)}
              >
                {t(`access.roleLabel.${role}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : kind === "appGrant" ? (
        <Select
          value={selectedAppId}
          onValueChange={setSelectedAppId}
          disabled={disabled}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={t("access.selectApplication")} />
          </SelectTrigger>
          <SelectContent>
            {applications.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                {t("access.noApplications")}
              </div>
            ) : (
              applications.map((app) => (
                <SelectItem
                  key={app.id}
                  value={app.id}
                  disabled={existingAppIds.has(app.id)}
                >
                  {app.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      ) : kind === "assetAssignment" ? (
        <Select
          value={selectedAssetId}
          onValueChange={setSelectedAssetId}
          disabled={disabled}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={t("access.selectAsset")} />
          </SelectTrigger>
          <SelectContent>
            {assets.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                {t("access.noAssets")}
              </div>
            ) : (
              assets.map((asset) => (
                <SelectItem
                  key={asset.id}
                  value={asset.id}
                  disabled={existingAssetIds.has(asset.id)}
                >
                  {asset.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      ) : null}

      {/* Add button — only shown once a kind (and valid subject) is chosen */}
      {kind ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!canAdd || disabled}
          className="w-full"
        >
          <PlusIcon />
          {t("access.addRule")}
        </Button>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// UserMultiPick — a simple checkbox-list for picking explicit users

function UserMultiPick({
  users,
  selected,
  onChange,
  disabled,
  t,
}: {
  users: User[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(id: string) {
    if (selectedSet.has(id)) {
      onChange(selected.filter((v) => v !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  if (users.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("access.noUsers")}</p>
    );
  }

  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/20 p-1.5">
      {users.map((user) => {
        const checked = selectedSet.has(user.id);
        return (
          <label
            key={user.id}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent/50",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(user.id)}
              disabled={disabled}
              className="size-3 rounded accent-primary"
            />
            <span className="truncate">
              {user.firstName} {user.lastName}
            </span>
          </label>
        );
      })}
    </div>
  );
}
