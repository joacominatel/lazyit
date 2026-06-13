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
import { useEffect, useState } from "react";
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
 *
 * STABILITY (#442): <UnlockGate> and <CreateVaultDialog> are always rendered at the SAME tree position
 * regardless of `isMissing`. This prevents mount/unmount churn from toggling the keypair observer,
 * which was the structural amplifier of the infinite-GET loop fixed in use-keypair.ts. The `isMissing`
 * flag now only controls INNER content (what <UnlockGate> shows), not which top-level tree is mounted.
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

  // When the session unlocks while the unlock dialog is open, close it — and if the user arrived from
  // "Create vault", advance to the create dialog. An EFFECT (not render-phase setState): it reacts to
  // the unlock state flipping, runs once per change, and never schedules redundant updates during render.
  useEffect(() => {
    if (!isUnlocked || !unlockOpen) return;
    setUnlockOpen(false);
    if (pendingCreate) {
      setPendingCreate(false);
      setCreateOpen(true);
    }
  }, [isUnlocked, unlockOpen, pendingCreate]);

  return (
    <div className="space-y-6">
      {/*
       * PageHeader: in first-run mode we omit the lock badge / create button because the user
       * has no keypair yet and those actions require one. The bootstrap form (rendered by
       * <UnlockGate> below) replaces the vault list body.
       */}
      <PageHeader
        title={t("list.title")}
        pillar="knowledge"
        icon={ShieldCheckIcon}
        subtitle={t("list.subtitle")}
        badge={
          !isMissing && isUnlocked ? (
            <button
              type="button"
              onClick={lock}
              className="inline-flex items-center gap-1.5 rounded-full bg-pillar-knowledge/10 px-2.5 py-1 text-xs font-medium text-pillar-knowledge transition-colors hover:bg-pillar-knowledge/20"
              title={t("session.lockHint")}
            >
              <LockOpenIcon className="size-3.5" aria-hidden />
              {t("session.unlocked")}
            </button>
          ) : !isMissing ? (
            <button
              type="button"
              onClick={() => setUnlockOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80"
              title={t("session.unlockHint")}
            >
              <LockClosedIcon className="size-3.5" aria-hidden />
              {t("session.locked")}
            </button>
          ) : undefined
        }
        actions={
          canManage && !isMissing ? (
            <Button onClick={handleCreateVault}>
              <PlusIcon />
              {t("vaults.createSubmit")}
            </Button>
          ) : null
        }
      />

      {/*
       * STABLE GATE: <UnlockGate> is always mounted at this position in the tree (never
       * moved between two different return branches). It decides internally what to show:
       *   - First-run (no keypair / isMissing): renders the BootstrapFlow.
       *   - Session locked (keypair exists): renders the UnlockFlow inline (not embedded,
       *     so it has its own card chrome that fills the page body instead of the vault list).
       *   - Session unlocked: renders children = <VaultListBody>.
       *
       * Because this element never unmounts/remounts as a function of `isMissing`, the
       * useMyKeypair observer inside <UnlockGate> stays stable and the retryOnMount guard
       * in use-keypair.ts never has a chance to trigger — defense-in-depth against #442.
       */}
      <UnlockGate>
        {/* Session unlocked — show the vault list body. */}
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

      {/*
       * Unlock dialog: shown when the user has a keypair but the session is locked and they
       * clicked the "Locked" badge or "Create vault". The embedded <UnlockGate> here is a
       * SECOND observer that only mounts when this Dialog is open. Because unlockOpen is
       * false by default (and Radix unmounts Dialog children when closed), this observer does
       * NOT exist on the initial render — it only appears after a user gesture. The
       * retryOnMount: false guard in useMyKeypair means even if this observer mounts while
       * the query is in error state it will not re-fetch.
       *
       * Not shown during first-run (isMissing=true): the bootstrap flow is handled by the
       * stable <UnlockGate> above; the "Locked" badge is hidden; the unlock dialog can't be
       * opened.
       */}
      {!isMissing ? (
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
      ) : null}

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
