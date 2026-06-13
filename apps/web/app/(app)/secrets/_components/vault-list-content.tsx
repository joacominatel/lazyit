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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { useCan } from "@/lib/hooks/use-permissions";
import { useMyKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import { useVaults } from "@/lib/secret-manager/hooks/use-vaults";
import { CreateVaultDialog } from "./create-vault-dialog";
import { UnlockGate } from "./unlock-gate";
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
 *
 * First-run UX (#438): when the user has no keypair (404 on `keypair/me`), the full page body is
 * replaced by the bootstrap flow via `<UnlockGate>` until they set a passphrase and are unlocked.
 * For a returning-but-locked user, the "Locked" badge becomes a button that opens an unlock dialog,
 * and "Create vault" routes through the same dialog so they are never stuck with a disabled button.
 */
export default function VaultListContent() {
  const t = useTranslations("secrets");
  const canManage = useCan("secret:manage");
  const { isUnlocked, lock } = useSecretSession();
  const { data: vaults, isLoading, isError, error, refetch } = useVaults();
  const { isError: keypairIsError, error: keypairError } = useMyKeypair();

  // A 404 on keypair/me means the user has never bootstrapped — first-run path.
  const isMissing =
    keypairIsError && keypairError instanceof ApiError && keypairError.status === 404;

  // Unlock dialog: opened by the "Locked" badge or by the "Create vault" button when locked.
  // `pendingCreate` tracks whether we should open the create dialog after unlock.
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && !isError && (vaults?.length ?? 0) === 0;

  function handleUnlockDialogChange(open: boolean) {
    setUnlockOpen(open);
    if (!open) setPendingCreate(false);
  }

  // Called by the unlock gate (via session) after unlock — because isUnlocked flips to true, the
  // Dialog re-renders and the <UnlockGate> returns its children (null fragment), closing naturally.
  // We also auto-advance to the create dialog if the user came from the "Create vault" button.
  function handleCreateVault() {
    if (!isUnlocked) {
      setPendingCreate(true);
      setUnlockOpen(true);
    } else {
      setCreateOpen(true);
    }
  }

  // When the session unlocks (isUnlocked flips true) while the unlock dialog is open with
  // pendingCreate, close the dialog and open the create dialog.
  if (isUnlocked && unlockOpen && pendingCreate) {
    // Schedule as microtask so React reconciles the unlock state first.
    Promise.resolve().then(() => {
      setUnlockOpen(false);
      setPendingCreate(false);
      setCreateOpen(true);
    });
  }

  // When the session unlocks while the unlock dialog is open (without pendingCreate), just close it.
  if (isUnlocked && unlockOpen && !pendingCreate) {
    Promise.resolve().then(() => setUnlockOpen(false));
  }

  // FIRST-RUN: no keypair at all → show the bootstrap flow as the page body (replaces the list
  // surface entirely). UnlockGate renders the bootstrap form; once done isUnlocked becomes true
  // and the keypair query re-fetches, so the gate naturally renders the vault list.
  if (isMissing) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("list.title")}
          pillar="knowledge"
          icon={ShieldCheckIcon}
          subtitle={t("list.subtitle")}
        />
        <UnlockGate>
          {/* UnlockGate shows the bootstrap form when there is no keypair.
              After the user finishes bootstrapping and is unlocked, this fragment renders
              and we fall through to the normal vault surface on the next render. */}
          <VaultListBody
            isLoading={isLoading}
            isError={isError}
            error={error}
            isEmpty={isEmpty}
            vaults={vaults}
            canManage={canManage}
            onCreateVault={handleCreateVault}
            onRetry={refetch}
            t={t}
          />
        </UnlockGate>
        {canManage ? (
          <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
        ) : null}
      </div>
    );
  }

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
            <button
              type="button"
              onClick={() => setUnlockOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80"
              title={t("session.unlockHint")}
            >
              <LockClosedIcon className="size-3.5" aria-hidden />
              {t("session.locked")}
            </button>
          )
        }
        actions={
          canManage ? (
            <Button onClick={handleCreateVault}>
              <PlusIcon />
              {t("vaults.createSubmit")}
            </Button>
          ) : null
        }
      />

      <VaultListBody
        isLoading={isLoading}
        isError={isError}
        error={error}
        isEmpty={isEmpty}
        vaults={vaults}
        canManage={canManage}
        onCreateVault={handleCreateVault}
        onRetry={refetch}
        t={t}
      />

      {/* Unlock dialog: shown when the user has a keypair but the session is locked.
          Wraps UnlockGate in embedded mode so there's no double-card chrome inside the Dialog. */}
      <Dialog open={unlockOpen} onOpenChange={handleUnlockDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("unlock.title")}</DialogTitle>
            <DialogDescription>
              {pendingCreate ? t("list.unlockToCreate") : t("unlock.description")}
            </DialogDescription>
          </DialogHeader>
          <UnlockGate embedded>
            {/* Session is now unlocked — nothing to show here; the dialog closes via the effect above. */}
            <span />
          </UnlockGate>
        </DialogContent>
      </Dialog>

      {canManage ? (
        <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: the vault list body (shared between first-run gate and normal flow)
// ---------------------------------------------------------------------------

type VaultListBodyProps = {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isEmpty: boolean;
  vaults: Array<{ id: string; name: string }> | undefined;
  canManage: boolean;
  onCreateVault: () => void;
  onRetry: () => void;
  t: ReturnType<typeof useTranslations<"secrets">>;
};

function VaultListBody({
  isLoading,
  isError,
  error,
  isEmpty,
  vaults,
  canManage,
  onCreateVault,
  onRetry,
  t,
}: VaultListBodyProps) {
  if (isLoading) return <VaultGridSkeleton />;
  if (isError) return <ErrorState title={t("list.errorTitle")} onRetry={onRetry} error={error} />;
  if (isEmpty) {
    return (
      <EmptyState
        icon={ShieldCheckIcon}
        pillar="knowledge"
        title={t("list.emptyTitle")}
        description={t("list.emptyDescription")}
        action={
          canManage ? { label: t("vaults.createSubmit"), onClick: onCreateVault } : undefined
        }
      />
    );
  }
  return (
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
