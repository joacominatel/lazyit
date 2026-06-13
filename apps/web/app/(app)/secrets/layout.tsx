"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCan, useMyPermissions } from "@/lib/hooks/use-permissions";
import { SecretManagerProvider } from "./_components/secret-session";

/**
 * /secrets layout — the Secret Manager session + access boundary (ADR-0061 §7, INV-10).
 *
 * THE SESSION SCOPE. {@link SecretManagerProvider} is mounted HERE, not in the global `(app)` shell, so
 * the in-memory secret material (the unlocked private key + the per-vault DEK cache) lives only while
 * the caller is somewhere under `/secrets`. Navigating OUT of the Secret Manager unmounts the provider
 * and drops every secret reference (the provider's unmount cleanup) — a structural "lock on leave" that
 * needs no explicit action.
 *
 * THE ACCESS GATE. `secret:read` is ADMIN-only (ADR-0061 §7 — even list/metadata access to vaults and
 * items is sensitive). This is a UI affordance only: the API's `@RequirePermission` guard is the real
 * gate. We FAIL CLOSED — while `/config/my-permissions` is loading, `can()` is false and we render the
 * skeleton (never a flash of vault chrome the API would 403), and a caller who lacks `secret:read` sees
 * a calm "no access" surface instead of the manager.
 *
 * This is a Client Component (the provider needs React state/refs); it does NOT import any crypto. The
 * crypto-touching content is loaded one level down, behind each page's `dynamic(..., { ssr:false })`
 * boundary, so the wasm/crypto graph never enters this server-rendered layout.
 */
export default function SecretsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("secrets");
  const { isLoading } = useMyPermissions();
  const canRead = useCan("secret:read");

  // Fail closed: hold the chrome until the permission set resolves, then either render the manager or a
  // quiet no-access note. Never briefly show vault chrome to someone the API will 403.
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

  return <SecretManagerProvider>{children}</SecretManagerProvider>;
}
