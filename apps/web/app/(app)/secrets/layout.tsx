"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCan, useMyPermissions } from "@/lib/hooks/use-permissions";

/**
 * /secrets layout — the Secret Manager access boundary (ADR-0061 §7, INV-10).
 *
 * THE SESSION SCOPE. `SecretManagerProvider` was previously mounted here but has been HOISTED to the
 * `(app)` layout (ADR-0061 §8) so the in-memory session is available app-wide — KB chips
 * (`{{ lazyit_secret.HANDLE }}`) can call the reveal flow from any article. The session drops on
 * logout (the `(app)` shell unmounts) and on an explicit lock action; it is no longer "lock on
 * leave /secrets" but "lock on leave the app or explicit action" — which is the correct scope.
 *
 * THE ACCESS GATE. `secret:read` is ADMIN-only (ADR-0061 §7 — even list/metadata access to vaults
 * and items is sensitive). This is a UI affordance only: the API's `@RequirePermission` guard is
 * the real gate. We FAIL CLOSED — while `/config/my-permissions` is loading, `can()` is false and
 * we render the skeleton (never a flash of vault chrome the API would 403), and a caller who lacks
 * `secret:read` sees a calm "no access" surface instead of the manager.
 *
 * This is a Client Component (it reads permissions client-side). The crypto-touching content is
 * loaded one level down, behind each page's `dynamic(..., { ssr:false })` boundary, so the
 * wasm/crypto graph never enters this server-rendered layout.
 */
export default function SecretsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("secrets");
  const { isLoading } = useMyPermissions();
  const canRead = useCan("secret:read");

  // Fail closed: hold the chrome until the permission set resolves, then either render the manager
  // or a quiet no-access note. Never briefly show vault chrome to someone the API will 403.
  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="size-6 animate-pulse rounded-full bg-muted" aria-hidden />
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl bg-card p-10 text-center ring-1 ring-foreground/10">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <LockClosedIcon className="size-6 text-muted-foreground" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">{t("noAccess.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("noAccess.description")}</p>
      </div>
    );
  }

  return <>{children}</>;
}
