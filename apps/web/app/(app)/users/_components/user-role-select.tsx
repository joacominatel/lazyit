"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { type Role, RoleSchema, type User } from "@lazyit/shared";
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
import { notifyError } from "@/lib/api/notify-error";
import { UserRoleBadge } from "./user-role-badge";

/** Human label + one-line meaning for each role, shown in the Select and the confirm prompt. */
const ROLE_OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: "ADMIN", label: "Admin", hint: "Full access, including user administration." },
  { value: "MEMBER", label: "Member", hint: "Normal inventory, KB and asset operations." },
  { value: "VIEWER", label: "Viewer", hint: "Read-only everywhere." },
];

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

interface UserRoleSelectProps {
  /** The user whose role is being shown/edited. */
  user: User;
  /** `sm` for the compact table cell, `md` (default) for the detail page. */
  size?: "sm" | "md";
}

/**
 * RBAC role control (ADR-0040). Self-contained: it reads the caller via `GET /users/me`
 * ({@link useCurrentUser}) — the OIDC token does NOT carry the lazyit role — and decides what to
 * render:
 *   - caller is NOT an ADMIN → a read-only {@link UserRoleBadge} (role management is ADMIN-only);
 *   - caller IS the target → a disabled badge (no self-escalation/demotion; the API 403s anyway);
 *   - caller is an ADMIN editing someone else → an editable Select with a confirmation step.
 *
 * The API is the real enforcement boundary: the last-admin (409) and self-role (403) guards are
 * surfaced verbatim via {@link notifyError} if the optimistic UI ever lets a blocked change through.
 */
export function UserRoleSelect({ user, size = "md" }: UserRoleSelectProps) {
  const { data: me } = useCurrentUser();
  const updateRole = useUpdateUserRole();
  const [pendingRole, setPendingRole] = useState<Role | null>(null);

  const isAdmin = me?.role === "ADMIN";
  const isSelf = me?.id === user.id;

  // Non-admins see a static badge; an admin viewing their own row sees a disabled badge (the API
  // forbids changing your own role — there must always be a second admin in the loop).
  if (!isAdmin) {
    return <UserRoleBadge role={user.role} />;
  }
  if (isSelf) {
    return (
      <span className="inline-flex items-center gap-2">
        <UserRoleBadge role={user.role} />
        <span className="text-xs text-muted-foreground">(you)</span>
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
            `${user.firstName} ${user.lastName} is now ${ROLE_LABEL[role]}`,
          );
          setPendingRole(null);
        },
        // Surfaces the API's friendly messages verbatim — the last-admin 409 ("Cannot remove the
        // last administrator…") and the self-role 403 ("You cannot change your own role").
        onError: (error) => {
          notifyError(error, "Couldn't change role");
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
          aria-label={`Role for ${user.firstName} ${user.lastName}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
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
            <AlertDialogTitle>Change role?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {user.firstName} {user.lastName}
              </span>{" "}
              will become{" "}
              <span className="font-medium text-foreground">
                {pendingRole ? ROLE_LABEL[pendingRole] : ""}
              </span>
              .{" "}
              {pendingRole
                ? ROLE_OPTIONS.find((o) => o.value === pendingRole)?.hint
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateRole.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* Plain button (not AlertDialogAction) so we own the spinner and only close on success. */}
            <Button onClick={handleConfirm} disabled={updateRole.isPending}>
              {updateRole.isPending && (
                <ArrowPathIcon className="animate-spin" />
              )}
              Change role
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
