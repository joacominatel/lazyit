"use client";

import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { UserRoleBadge } from "@/app/(app)/users/_components/user-role-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePermissions } from "@/lib/hooks/use-permissions";

/**
 * Topbar user menu — shows real session identity from Auth.js v5 (ADR-0039) plus the caller's RBAC
 * role (ADR-0040) as a badge, so the role that gates write affordances is finally visible.
 *
 * Reads identity (name/email) from the Auth.js client session (`useSession`). The session is
 * populated by the OIDC provider after sign-in; the access token is stored in the JWT cookie (not
 * exposed here — it lives in session.accessToken and is forwarded via apiFetch). The RBAC role is
 * NOT in the OIDC token, so it comes from `usePermissions()` (→ `/users/me`), reusing the same
 * `UserRoleBadge` the Users module renders.
 */
export function UserMenu() {
  const { data: session } = useSession();
  const { role } = usePermissions();

  const name = session?.user?.name ?? "—";
  const email = session?.user?.email ?? "";

  // Initials: first character of each word in the name (max 2).
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

  function handleSignOut() {
    signOut({ callbackUrl: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="Open user menu"
        >
          <Avatar className="size-8">
            <AvatarFallback>{initials || "?"}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{name}</span>
            {email && (
              <span className="text-xs text-muted-foreground">{email}</span>
            )}
            {role && (
              <span className="mt-0.5">
                <UserRoleBadge role={role} />
              </span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
