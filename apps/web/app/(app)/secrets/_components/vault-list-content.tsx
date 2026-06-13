"use client";

import {
  ArrowRightIcon,
  LockClosedIcon,
  LockOpenIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/hooks/use-permissions";
import { useVaults } from "@/lib/secret-manager/hooks/use-vaults";
import { CreateVaultDialog } from "./create-vault-dialog";
import { useSecretSession } from "./secret-session";

/**
 * VaultListContent — the Secret Manager landing surface (ADR-0061 §7). Default-exported so the page
 * shell can `dynamic(..., { ssr:false })` it; this is where the crypto graph first enters (via the
 * create-vault dialog + the unlock-on-create flow). Matches the KB list chrome: `PageHeader` with the
 * knowledge pillar, a responsive card grid, and the shared loading / empty / error states.
 *
 * The list itself is just vault METADATA (names) — the API returns the caller's vaults (an ADMIN sees
 * all). No secret material is touched to render it; unlocking only happens when the caller opens a vault
 * to reveal an item. A small session indicator shows whether the in-memory key is unlocked or locked,
 * with a "Lock" action that drops it.
 */
export default function VaultListContent() {
  const t = useTranslations("secrets");
  const canManage = useCan("secret:manage");
  const { isUnlocked, lock } = useSecretSession();
  const { data: vaults, isLoading, isError, error, refetch } = useVaults();
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && !isError && (vaults?.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="knowledge"
        icon={ShieldCheckIcon}
        subtitle={t("list.subtitle")}
        badge={
          isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              className="inline-flex items-center gap-1.5 rounded-full bg-pillar-knowledge/10 px-2.5 py-1 text-xs font-medium text-pillar-knowledge transition-colors hover:bg-pillar-knowledge/20"
              title={t("session.lockHint")}
            >
              <LockOpenIcon className="size-3.5" aria-hidden />
              {t("session.unlocked")}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <LockClosedIcon className="size-3.5" aria-hidden />
              {t("session.locked")}
            </span>
          )
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              {t("vaults.createSubmit")}
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <VaultGridSkeleton />
      ) : isError ? (
        <ErrorState title={t("list.errorTitle")} onRetry={() => refetch()} error={error} />
      ) : isEmpty ? (
        <EmptyState
          icon={ShieldCheckIcon}
          pillar="knowledge"
          title={t("list.emptyTitle")}
          description={t("list.emptyDescription")}
          action={
            canManage
              ? { label: t("vaults.createSubmit"), onClick: () => setCreateOpen(true) }
              : undefined
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {vaults?.map((vault) => (
            <li key={vault.id}>
              <Link
                href={`/secrets/${vault.id}`}
                className="group flex h-full flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:ring-pillar-knowledge/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-pillar-knowledge/10 text-pillar-knowledge">
                    <LockClosedIcon className="size-5" aria-hidden />
                  </span>
                  <ArrowRightIcon
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                    aria-hidden
                  />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium">{vault.name}</p>
                  <p className="text-xs text-muted-foreground">{t("vaults.openHint")}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </div>
  );
}

/** Card-grid skeleton matching the vault card footprint. */
function VaultGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {["a", "b", "c", "d", "e", "f"].map((key) => (
        <div key={key} className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between">
            <div className="size-9 animate-pulse rounded-lg bg-muted" />
          </div>
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
