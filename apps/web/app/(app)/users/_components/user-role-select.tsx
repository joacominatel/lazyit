"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { type Role, RoleSchema, type User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateUserRole } from "@/lib/api/hooks/use-user-mutations";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";
import { UserRoleBadge } from "./user-role-badge";

/** The role values shown in the Select, in display order. Labels/hints are resolved via i18n. */
const ROLE_VALUES: Role[] = ["ADMIN", "MEMBER", "VIEWER"];

interface UserRoleSelectProps {
  /** The user whose role is being shown/edited. */
  user: User;
  /** `sm` for the compact table cell, `md` (default) for the detail page. */
  size?: "sm" | "md";
}

/**
 * RBAC role control (ADR-0040 → ADR-0046). Self-contained: it reads the caller's identity via
 * `GET /users/me` ({@link useCurrentUser}, for the self-check) and their effective permissions via
 * {@link useCan} (`user:manage`), then decides what to render:
 *   - caller LACKS `user:manage` → a read-only {@link UserRoleBadge} (role management is gated);
 *   - caller IS the target → a disabled badge (no self-escalation/demotion; the API 403s anyway);
 *   - caller HOLDS `user:manage` editing someone else → an editable Select with a confirmation step.
 *
 * The API is the real enforcement boundary: the last-admin (409) and self-role (403) guards are
 * surfaced verbatim via {@link notifyError} if the optimistic UI ever lets a blocked change through.
 */
export function UserRoleSelect({ user, size = "md" }: UserRoleSelectProps) {
  const t = useTranslations("users.role");
  const tc = useTranslations("common");
  const { data: me } = useCurrentUser();
  const canManage = useCan("user:manage");
  const updateRole = useUpdateUserRole();
  const [pendingRole, setPendingRole] = useState<Role | null>(null);

  const isSelf = me?.id === user.id;
  const roleLabel = (role: Role) => t(`labels.${role}`);

  // Without user:manage the caller sees a static badge; a manager viewing their own row sees a
  // disabled badge (the API forbids changing your own role — there must always be a second admin).
  if (!canManage) {
    return <UserRoleBadge role={user.role} />;
  }
  if (isSelf) {
    return (
      <span className="inline-flex items-center gap-2">
        <UserRoleBadge role={user.role} />
        <span className="text-xs text-muted-foreground">
          {t("selfSuffix")}
        </span>
      </span>
    );
  }

  function handleConfirm() {
    if (pendingRole == null) return;
    const role = pendingRole;
    updateRole.mutate(
      { id: user.id, role },
      {
        onSuccess: () => {
          toast.success(
            t("toast.changed", {
              name: `${user.firstName} ${user.lastName}`,
              role: roleLabel(role),
            }),
          );
          setPendingRole(null);
        },
        // Surfaces the API's friendly messages verbatim — the last-admin 409 ("Cannot remove the
        // last administrator…") and the self-role 403 ("You cannot change your own role").
        onError: (error) => {
          notifyError(error, t("toast.error"));
          setPendingRole(null);
        },
      },
    );
  }

  return (
    <>
      <Select
        value={user.role}
        onValueChange={(value) => {
          const next = RoleSchema.parse(value);
          // Opening the confirm only when the role actually changes avoids a no-op prompt.
          if (next !== user.role) setPendingRole(next);
        }}
      >
        <SelectTrigger
          size={size === "sm" ? "sm" : "default"}
          className={size === "sm" ? "h-8 w-[7.5rem]" : "w-44"}
          aria-label={t("ariaLabel", {
            name: `${user.firstName} ${user.lastName}`,
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {roleLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog
        open={pendingRole != null}
        onOpenChange={(open) => {
          if (!open) setPendingRole(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.rich("confirmBody", {
                name: `${user.firstName} ${user.lastName}`,
                role: pendingRole ? roleLabel(pendingRole) : "",
                strong: (chunks) => (
                  <span className="font-medium text-foreground">{chunks}</span>
                ),
              })}{" "}
              {pendingRole ? t(`hints.${pendingRole}`) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateRole.isPending}>
              {tc("cancel")}
            </AlertDialogCancel>
            {/* Plain button (not AlertDialogAction) so we own the spinner and only close on success. */}
            <Button onClick={handleConfirm} disabled={updateRole.isPending}>
              {updateRole.isPending && (
                <ArrowPathIcon className="animate-spin" />
              )}
              {t("confirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
