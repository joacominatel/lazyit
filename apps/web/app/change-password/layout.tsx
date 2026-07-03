import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AuthShell } from "@/components/auth-shell";
import { getConfigStatus } from "@/lib/api/endpoints/config";

/**
 * Layout for the blocking forced-password-change wall (`/change-password`, ADR-0086 §F4b, control 2).
 * It lives OUTSIDE the `(app)` group on purpose: no sidebar, no topbar, no app queries — a bare
 * AuthShell so the user cannot click past it into the app until they rotate their one-time credential.
 *
 * Guards:
 *   - No session → /login (they must authenticate first; the guard's 403 only reaches an authed user).
 *   - Not local mode → /dashboard. The forced-change gate only exists in AUTH_MODE=local; an OIDC
 *     instance never sends anyone here, so a manually-typed URL is bounced back — the OIDC path stays
 *     byte-identical. Config read fails safe (treat as local so a transient API blip can't strand a
 *     genuinely-walled user away from their only escape hatch).
 */
export default async function ChangePasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  let isLocal = true;
  try {
    const status = await getConfigStatus(session.accessToken);
    isLocal = status.authMode === "local";
  } catch {
    // Fail safe: keep the wall reachable rather than bounce a walled-off user to a route they can't use.
  }
  if (!isLocal) {
    redirect("/dashboard");
  }

  return <AuthShell contentClassName="max-w-md">{children}</AuthShell>;
}
