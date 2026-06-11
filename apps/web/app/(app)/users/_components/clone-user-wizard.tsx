"use client";

import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  type CloneUser,
  type CloneUserResult,
  CloneUserSchema,
  type ManagerFormValue,
  type Role,
  RoleSchema,
  toManagerInput,
} from "@lazyit/shared";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/ui/status-badge";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useCloneUser } from "@/lib/api/hooks/use-user-mutations";
import {
  useUserAssignments,
  useUserGrants,
} from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";
import { formatDate } from "@/lib/utils/format";
import { ManagerField } from "./manager-field";

const FORM_ID = "clone-user-form";
const ROLE_VALUES: Role[] = ["ADMIN", "MEMBER", "VIEWER"];

/** The source user the clone is templated from (only the fields the wizard needs). */
export interface CloneSource {
  id: string;
  firstName: string;
  lastName: string;
}

/** The new hire's profile inputs (a CreateUser-shaped form, manager as the XOR form value). */
interface ProfileValues {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  legajo: string;
  username: string;
  manager: ManagerFormValue;
}

function blankProfile(source: CloneSource): ProfileValues {
  return {
    // The clone NEVER pre-fills the source email/legajo/username (those are unique) — only the names,
    // as a convenience starting point the operator overwrites. Role defaults to least-privilege VIEWER.
    email: "",
    firstName: source.firstName,
    lastName: source.lastName,
    role: "VIEWER",
    legajo: "",
    username: "",
    manager: { kind: "none" },
  };
}

interface CloneUserWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The user being cloned. */
  source: CloneSource;
}

/**
 * The server-orchestrated clone wizard (ADR-0058 §4) — the heavier sibling of the in-form clone
 * pre-fill. It mints a NEW user from the operator-supplied `profile` AND opt-in mirrors the SOURCE's
 * ACTIVE asset assignments + access grants (checklists), with an explicit, safe-by-default engine
 * toggle deciding whether the cloned grants fire the workflow engine (provision the new hire). On
 * success it shows the per-item result (created + the `skipped` list with reasons) and offers to open
 * the new user.
 *
 * Gating is the caller's job (`user:manage`) — this dialog assumes it only renders for an admin, and
 * the API re-enforces the permission regardless.
 */
export function CloneUserWizard({
  open,
  onOpenChange,
  source,
}: CloneUserWizardProps) {
  const t = useTranslations("users.clone");
  const tf = useTranslations("users.form");
  const tc = useTranslations("common");
  const router = useRouter();
  const clone = useCloneUser();

  const [profile, setProfile] = useState<ProfileValues>(() =>
    blankProfile(source),
  );
  // Selected assignment / grant ids (Sets keep selection unique by construction — ADR-0058).
  const [selectedAssignments, setSelectedAssignments] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedGrants, setSelectedGrants] = useState<Set<string>>(
    () => new Set(),
  );
  const [fireWorkflows, setFireWorkflows] = useState(false);
  const [result, setResult] = useState<CloneUserResult | null>(null);
  // Per-field validation errors keyed by the CloneUserSchema profile path (e.g. "email").
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The source's ACTIVE footprint to offer as checklists.
  const { data: assignments, isLoading: assignmentsLoading } =
    useUserAssignments(open ? source.id : undefined, true);
  const { data: grants, isLoading: grantsLoading } = useUserGrants(
    open ? source.id : undefined,
    true,
  );
  // Catalogs to resolve the lean FK ids (assetId / applicationId) to display labels.
  const { data: assetsPage } = useAssets({ limit: MAX_PAGE_LIMIT });
  const { data: applications } = useApplications();

  const assetNameById = useMemo(
    () =>
      new Map((assetsPage?.items ?? []).map((a) => [a.id, a.name] as const)),
    [assetsPage],
  );
  const appNameById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a.name] as const)),
    [applications],
  );

  // No reset-on-open effect: the parent mounts this dialog conditionally with a per-source `key`, so a
  // fresh open is always a fresh mount with the initial state above — never stale input from a prior clone.

  const activeAssignments = assignments ?? [];
  const activeGrants = grants ?? [];

  function toggleAssignment(id: string, on: boolean) {
    setSelectedAssignments((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleGrant(id: string, on: boolean) {
    setSelectedGrants((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function buildPayload(): CloneUser {
    const manager = toManagerInput(profile.manager);
    const legajo = profile.legajo.trim();
    const username = profile.username.trim();
    return {
      profile: {
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        role: profile.role,
        ...(legajo !== "" ? { legajo } : {}),
        ...(username !== "" ? { username } : {}),
        manager,
      },
      cloneAssetAssignments: [...selectedAssignments],
      cloneAccessGrants: [...selectedGrants],
      fireWorkflowsOnClonedGrants: fireWorkflows,
    };
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const parsed = CloneUserSchema.safeParse(buildPayload());
    if (!parsed.success) {
      // Surface field errors under their last path segment (the profile fields the operator can fix).
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[issue.path.length - 1];
        if (typeof key === "string" && !(key in next)) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    clone.mutate(
      { sourceId: source.id, body: parsed.data },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(
            t("toast.created", {
              name: `${res.created.firstName} ${res.created.lastName}`,
            }),
          );
        },
        onError: (error) => notifyError(error, t("toast.error")),
      },
    );
  }

  const grantCount = selectedGrants.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("title", { name: `${source.firstName} ${source.lastName}` })}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <CloneResult
            result={result}
            assetNameById={assetNameById}
            appNameById={appNameById}
          />
        ) : (
          <form
            id={FORM_ID}
            onSubmit={onSubmit}
            noValidate
            className="min-h-0 flex-1 overflow-y-auto pr-1"
          >
            <FieldGroup>
              {/* — Profile — */}
              <p className="text-sm font-medium text-foreground">
                {t("sections.profile")}
              </p>

              <Field data-invalid={Boolean(errors.firstName) || undefined}>
                <FieldLabel htmlFor="clone-firstName">
                  {tf("firstName")}
                </FieldLabel>
                <Input
                  id="clone-firstName"
                  value={profile.firstName}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, firstName: e.target.value }))
                  }
                  aria-invalid={Boolean(errors.firstName) || undefined}
                  autoFocus
                />
                {errors.firstName && <FieldError errors={[{ message: errors.firstName }]} />}
              </Field>

              <Field data-invalid={Boolean(errors.lastName) || undefined}>
                <FieldLabel htmlFor="clone-lastName">
                  {tf("lastName")}
                </FieldLabel>
                <Input
                  id="clone-lastName"
                  value={profile.lastName}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, lastName: e.target.value }))
                  }
                  aria-invalid={Boolean(errors.lastName) || undefined}
                />
                {errors.lastName && <FieldError errors={[{ message: errors.lastName }]} />}
              </Field>

              <Field data-invalid={Boolean(errors.email) || undefined}>
                <FieldLabel htmlFor="clone-email">{tf("email")}</FieldLabel>
                <Input
                  id="clone-email"
                  type="email"
                  value={profile.email}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, email: e.target.value }))
                  }
                  placeholder="ada@lazyit.dev"
                  aria-invalid={Boolean(errors.email) || undefined}
                />
                <FieldDescription>{t("emailHelp")}</FieldDescription>
                {errors.email && <FieldError errors={[{ message: errors.email }]} />}
              </Field>

              <Field>
                <FieldLabel htmlFor="clone-role">{t("role")}</FieldLabel>
                <Select
                  value={profile.role}
                  onValueChange={(value) =>
                    setProfile((p) => ({ ...p, role: RoleSchema.parse(value) }))
                  }
                >
                  <SelectTrigger id="clone-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`roleLabels.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field data-invalid={Boolean(errors.legajo) || undefined}>
                <FieldLabel htmlFor="clone-legajo">{tf("legajo")}</FieldLabel>
                <Input
                  id="clone-legajo"
                  value={profile.legajo}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, legajo: e.target.value }))
                  }
                  placeholder={tf("legajoPlaceholder")}
                  aria-invalid={Boolean(errors.legajo) || undefined}
                />
                {errors.legajo && <FieldError errors={[{ message: errors.legajo }]} />}
              </Field>

              <Field data-invalid={Boolean(errors.username) || undefined}>
                <FieldLabel htmlFor="clone-username">
                  {tf("username")}
                </FieldLabel>
                <Input
                  id="clone-username"
                  value={profile.username}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, username: e.target.value }))
                  }
                  placeholder={tf("usernamePlaceholder")}
                  aria-invalid={Boolean(errors.username) || undefined}
                />
                {errors.username && <FieldError errors={[{ message: errors.username }]} />}
              </Field>

              <Field>
                <FieldLabel htmlFor="clone-manager">
                  {tf("manager.label")}
                </FieldLabel>
                <ManagerField
                  id="clone-manager"
                  value={profile.manager}
                  onChange={(manager) =>
                    setProfile((p) => ({ ...p, manager }))
                  }
                />
              </Field>

              {/* — Assets to carry over — */}
              <p className="pt-2 text-sm font-medium text-foreground">
                {t("sections.assets")}
              </p>
              <ChecklistSection
                loading={assignmentsLoading}
                emptyText={t("assets.empty")}
                loadingText={t("loading")}
                items={activeAssignments.map((a) => ({
                  id: a.id,
                  label:
                    assetNameById.get(a.assetId) ?? t("assets.assetFallback"),
                  meta: t("assets.assignedOn", {
                    date: formatDate(a.assignedAt),
                  }),
                }))}
                selected={selectedAssignments}
                onToggle={toggleAssignment}
                idPrefix="clone-assignment"
              />

              {/* — Access to carry over — */}
              <p className="pt-2 text-sm font-medium text-foreground">
                {t("sections.access")}
              </p>
              <ChecklistSection
                loading={grantsLoading}
                emptyText={t("access.empty")}
                loadingText={t("loading")}
                items={activeGrants.map((g) => ({
                  id: g.id,
                  label:
                    appNameById.get(g.applicationId) ??
                    t("access.applicationFallback"),
                  meta: g.accessLevel ?? undefined,
                }))}
                selected={selectedGrants}
                onToggle={toggleGrant}
                idPrefix="clone-grant"
              />

              {/* — Engine toggle — */}
              <Field orientation="horizontal" className="pt-2">
                <FieldContent>
                  <FieldLabel htmlFor="clone-fire">
                    {t("fire.label")}
                  </FieldLabel>
                  <FieldDescription>{t("fire.help")}</FieldDescription>
                </FieldContent>
                <Switch
                  id="clone-fire"
                  checked={fireWorkflows}
                  onCheckedChange={setFireWorkflows}
                />
              </Field>

              {fireWorkflows && grantCount > 0 && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
                >
                  <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>{t("fire.warning", { count: grantCount })}</span>
                </div>
              )}
            </FieldGroup>
          </form>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {tc("close")}
              </Button>
              <Button
                onClick={() => {
                  router.push(`/users/${result.created.id}`);
                  onOpenChange(false);
                }}
              >
                {t("viewUser")}
                <ArrowTopRightOnSquareIcon />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={clone.isPending}
              >
                {tc("cancel")}
              </Button>
              <Button type="submit" form={FORM_ID} disabled={clone.isPending}>
                {clone.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("submit")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One opt-in checklist (assignments or grants) — loading / empty / a list of labeled checkboxes. */
function ChecklistSection({
  loading,
  loadingText,
  emptyText,
  items,
  selected,
  onToggle,
  idPrefix,
}: {
  loading: boolean;
  loadingText: string;
  emptyText: string;
  items: { id: string; label: string; meta?: string }[];
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  idPrefix: string;
}) {
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {loadingText}
      </p>
    );
  }
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((item) => {
        const inputId = `${idPrefix}-${item.id}`;
        return (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
            <Checkbox
              id={inputId}
              checked={selected.has(item.id)}
              onCheckedChange={(c) => onToggle(item.id, c === true)}
            />
            <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
              <span className="block truncate text-sm font-medium">
                {item.label}
              </span>
              {item.meta && (
                <span className="block truncate text-xs text-muted-foreground">
                  {item.meta}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** The post-clone result: the created user + the per-item skipped list with reasons. */
function CloneResult({
  result,
  assetNameById,
  appNameById,
}: {
  result: CloneUserResult;
  assetNameById: Map<string, string>;
  appNameById: Map<string, string>;
}) {
  const t = useTranslations("users.clone.result");
  const { created, skipped } = result;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <div className="rounded-lg border border-success/40 bg-success/10 p-3">
        <p className="text-sm font-medium text-foreground">
          {t("createdTitle")}
        </p>
        <p className="text-sm text-muted-foreground">
          {created.firstName} {created.lastName} · {created.email}
        </p>
      </div>

      {skipped.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {t("skippedTitle", { count: skipped.length })}
          </p>
          <ul className="divide-y rounded-lg border text-sm">
            {skipped.map((item) => {
              // Resolve a friendly label from the UNDERLYING asset/app id the API resolved the skipped
              // item to (`entityId`); the catalog maps are keyed by asset/app id, not the requested
              // assignment/grant id. Falls back to the raw id when there is nothing to resolve (e.g. a
              // `not_found` item never matched an active source row, so it carries no entityId).
              const label =
                (item.entityId &&
                  (assetNameById.get(item.entityId) ??
                    appNameById.get(item.entityId))) ??
                item.id;
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 truncate">{label}</span>
                  <StatusBadge tone="warning">
                    {t.has(`reasons.${item.reason}`)
                      ? t(`reasons.${item.reason}`)
                      : item.reason}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noneSkipped")}</p>
      )}

      <Button variant="outline" size="sm" asChild>
        <Link href={`/users/${created.id}`}>{t("openLink")}</Link>
      </Button>
    </div>
  );
}
