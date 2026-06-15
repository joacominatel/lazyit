"use client";

import { LockOpenIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
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
import { LocaleSwitcher } from "@/components/locale-switcher";
import { avatarColorFor } from "@/lib/avatar-color";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";

/**
 * Topbar user menu — shows real session identity from Auth.js v5 (ADR-0039) plus the caller's RBAC
 * role (ADR-0040) as a badge, so the role that gates write affordances is finally visible.
 *
 * Reads identity (name/email) from the Auth.js client session (`useSession`). The session is
 * populated by the OIDC provider after sign-in; the access token is stored in the JWT cookie (not
 * exposed here — it lives in session.accessToken and is forwarded via apiFetch). The RBAC role is
 * NOT in the OIDC token, so it comes from `usePermissions()` (→ `/users/me`), reusing the same
 * `UserRoleBadge` the Users module renders.
 *
 * SM-WEB-04: it also hosts the app-wide Secret Manager lock affordance. The in-memory secret session
 * (ADR-0061 §8) is now app-wide — a user can unlock it from a KB chip in `/kb` — but the only Lock
 * action + unlocked indicator used to live on the `/secrets` landing. The menu item below is gated to
 * `useCan('secret:read')` AND `isUnlocked`, so a holder who has an unlocked session can see the state
 * and `lock()` it from anywhere. It renders nothing otherwise. The UserMenu now sits inside the
 * `SecretManagerProvider` (hoisted in `(app)/layout.tsx`), so `useSecretSession()` is always available.
 */
export function UserMenu() {
  const t = useTranslations("shared");
  const ts = useTranslations("secrets");
  const { data: session } = useSession();
  const { role } = usePermissions();
  // App-wide Secret Manager lock affordance (SM-WEB-04). Gated: only a `secret:read` holder with an
  // unlocked session sees it. `lock()` drops the in-memory private key + DEK cache (INV-10) — no secret
  // material is ever read or rendered here, only the boolean state and the lock action.
  const canReadSecrets = useCan("secret:read");
  const { isUnlocked, lock } = useSecretSession();
  const showLock = canReadSecrets && isUnlocked;

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
    // #512: clear the in-memory secret session BEFORE signing out. `signOut` triggers a full-page
    // navigation that unmounts the provider (which also drops the key + DEKs), but locking explicitly
    // makes key-clearing intention-revealing and navigation-independent — so a future soft client-side
    // sign-out, or a `signOut` that errors before navigating, can never leave the unlocked private key
    // and cached DEKs resident in memory (notably on shared workstations). Safe to call when locked.
    lock();
    signOut({ callbackUrl: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t("chrome.openUserMenu")}
        >
          <Avatar className="size-8">
            {/* Seed the current user's own chip from the same canonical palette so they read the
                identity colour here that they wear on Users, asset owners and grants. Falls back to
                the bare muted chip only when the session carries no email to seed from. */}
            <AvatarFallback
              className={cn("font-medium", email && avatarColorFor(email))}
            >
              {initials || "?"}
            </AvatarFallback>
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
        {/* Locale switcher (ADR-0051): a Globe sub-menu with EN / ES. */}
        <LocaleSwitcher />
        {/* SM-WEB-04: app-wide Secret Manager lock. Shown only to a `secret:read` holder whose session
            is currently unlocked. Clicking locks the session (drops the in-memory key + DEK cache). */}
        {showLock ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={lock}>
              <LockOpenIcon className="text-pillar-knowledge" aria-hidden />
              {ts("session.lockApp")}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          {t("chrome.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
