"use client";

import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  UserMinusIcon,
  UserPlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type { SecretItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { useUsers } from "@/lib/api/hooks/use-users";
import {
  openItem,
  sealItem,
  wrapDekForMember,
} from "@/lib/secret-manager/crypto";
import {
  useCreateItem,
  useDeleteItem,
  useItems,
  useUpdateItem,
} from "@/lib/secret-manager/hooks/use-items";
import {
  useAddMember,
  useMembers,
  useMyMembership,
  useRemoveMember,
} from "@/lib/secret-manager/hooks/use-members";
import { useUserPublicKey } from "@/lib/secret-manager/hooks/use-keypair";
import { useVault } from "@/lib/secret-manager/hooks/use-vaults";
import { base64ToBytes } from "./crypto-bytes";
import { useSecretSession } from "./secret-session";
import { UnlockGate } from "./unlock-gate";
import { useVaultDek } from "./use-vault-dek";

/** How long (ms) a revealed value stays visible before auto-masking. */
const REVEAL_TIMEOUT_MS = 15_000;

/**
 * VaultDetailContent — the vault detail page (items + members), ADR-0061 §3/§6/§7.
 *
 * Loaded via `dynamic(..., { ssr:false })` from `[vaultId]/page.tsx` — the crypto read chain
 * (unlock → unwrap DEK → open item) must run client-only.
 *
 * THE ZERO-KNOWLEDGE LINE: revealed plaintext lives in per-item component state only while the
 * user has clicked "reveal" — never in a Query key, never in localStorage, never logged. A
 * `REVEAL_TIMEOUT_MS` auto-mask drops each revealed value after a short window. The DEK is held
 * by the `SecretManagerProvider` session (via `use-vault-dek`); we never put it in any prop,
 * return value, or state that survives a re-render outside the provider.
 *
 * MEMBERS: revoking a member drops their wrapped-DEK row — they can no longer fetch a new DEK —
 * but a CACHED plaintext is not retroactively destroyed (hard revoke / DEK rotation is deferred).
 * The UI surfaces this loudly so admins understand what "revoke" does and does not do.
 */
export default function VaultDetailContent({ vaultId }: { vaultId: string }) {
  return (
    <UnlockGate>
      <VaultDetail vaultId={vaultId} />
    </UnlockGate>
  );
}

/** The inner detail (rendered only once the session is unlocked via UnlockGate). */
function VaultDetail({ vaultId }: { vaultId: string }) {
  const t = useTranslations("secrets");
  const canManage = useCan("secret:manage");
  const { data: vault, isLoading: vaultLoading } = useVault(vaultId);
  const { data: items, isLoading: itemsLoading } = useItems(vaultId);
  const { data: members, isLoading: membersLoading } = useMembers(vaultId);

  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  return (
    <div className="space-y-8">
      <PageHeader
        title={
          vaultLoading ? (
            <span className="inline-block h-6 w-48 animate-pulse rounded bg-muted" />
          ) : (
            (vault?.name ?? t("detail.unknownVault"))
          )
        }
        pillar="knowledge"
        icon={ShieldCheckIcon}
        subtitle={t("detail.subtitle")}
        breadcrumb={
          <Link
            href="/secrets"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            {t("list.title")}
          </Link>
        }
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setAddItemOpen(true)}>
              <PlusIcon className="size-4" />
              {t("items.addItem")}
            </Button>
          ) : null
        }
      />

      {/* Items section */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">{t("items.sectionTitle")}</h2>

        {itemsLoading ? (
          <ItemsSkeleton />
        ) : !items || items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("items.empty")}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                vaultId={vaultId}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Members section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t("members.sectionTitle")}</h2>
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddMemberOpen(true)}
            >
              <UserPlusIcon className="size-4" />
              {t("members.addMember")}
            </Button>
          ) : null}
        </div>

        {/* Single-member safety nudge */}
        {!membersLoading && members && members.length === 1 ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            {t("members.singleMemberWarning")}
          </p>
        ) : null}

        {membersLoading ? (
          <MembersSkeleton />
        ) : !members || members.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("members.empty")}
          </div>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                vaultId={vaultId}
                canManage={canManage}
                membersCount={members.length}
              />
            ))}
          </ul>
        )}

        {/* Revoke-semantics nudge — shown only to managers who can trigger a revoke */}
        {canManage ? (
          <p className="text-xs text-muted-foreground">
            {t("members.revokeSemanticNote")}
          </p>
        ) : null}
      </section>

      {/* Dialogs */}
      {canManage ? (
        <>
          <AddItemDialog
            open={addItemOpen}
            onOpenChange={setAddItemOpen}
            vaultId={vaultId}
          />
          <AddMemberDialog
            open={addMemberOpen}
            onOpenChange={setAddMemberOpen}
            vaultId={vaultId}
          />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ItemRow — one secret item with click-to-reveal
// ---------------------------------------------------------------------------

interface ItemRowProps {
  item: SecretItem;
  vaultId: string;
  canManage: boolean;
}

function ItemRow({ item, vaultId, canManage }: ItemRowProps) {
  const t = useTranslations("secrets");
  const { ensureDek } = useVaultDek(vaultId);

  // SECURITY: plaintext lives ONLY in this local state. Never put it in a query key,
  // localStorage, or prop. Auto-clear after REVEAL_TIMEOUT_MS.
  const [plaintext, setPlaintext] = useState<string | undefined>(undefined);
  const [revealError, setRevealError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup the auto-mask timer on unmount.
  useEffect(() => () => clearTimeout(maskTimerRef.current), []);

  const handleReveal = useCallback(() => {
    if (plaintext !== undefined) {
      // Second click → mask immediately.
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
      return;
    }
    const dek = ensureDek();
    if (!dek) {
      // Session was locked (shouldn't happen inside UnlockGate, but be safe).
      setRevealError(true);
      return;
    }
    try {
      const value = openItem(dek, {
        ciphertext: item.ciphertext,
        iv: item.iv,
        authTag: item.authTag,
        keyVersion: item.keyVersion,
      });
      setRevealError(false);
      setPlaintext(value);
      // Auto-mask after timeout.
      clearTimeout(maskTimerRef.current);
      maskTimerRef.current = setTimeout(() => setPlaintext(undefined), REVEAL_TIMEOUT_MS);
    } catch {
      // Wrong DEK or tampered ciphertext — surface a friendly error, never the raw exception.
      setRevealError(true);
    }
  }, [plaintext, ensureDek, item]);

  function handleCopy() {
    if (!plaintext) return;
    void navigator.clipboard?.writeText(plaintext).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <li className="flex items-center gap-3 rounded-lg bg-card p-3 ring-1 ring-foreground/10">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-pillar-knowledge/10 text-pillar-knowledge">
        <KeyIcon className="size-4" aria-hidden />
      </span>

      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">{item.label}</p>
        <p className="truncate text-xs text-muted-foreground font-mono">{item.handle}</p>

        {/* Value area */}
        <div className="mt-1.5 flex items-center gap-2">
          {plaintext !== undefined ? (
            <>
              <code className="max-w-xs truncate rounded bg-muted/60 px-2 py-0.5 text-xs font-mono select-all">
                {plaintext}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                title={t("items.copy")}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-pillar-knowledge" aria-hidden />
                ) : (
                  <ClipboardIcon className="size-3.5" aria-hidden />
                )}
              </button>
            </>
          ) : revealError ? (
            <span className="text-xs text-destructive">{t("items.revealError")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{"•".repeat(16)}</span>
          )}
        </div>
      </div>

      {/* Row actions */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={handleReveal}
          title={plaintext !== undefined ? t("items.mask") : t("items.reveal")}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {plaintext !== undefined ? (
            <EyeSlashIcon className="size-4" aria-hidden />
          ) : (
            <EyeIcon className="size-4" aria-hidden />
          )}
        </button>

        {canManage ? (
          <>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              title={t("items.edit")}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PencilIcon className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              title={t("items.delete")}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <TrashIcon className="size-4" aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      {/* Edit dialog */}
      <EditItemDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        vaultId={vaultId}
        item={item}
      />

      {/* Delete confirm dialog */}
      <DeleteItemDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        vaultId={vaultId}
        item={item}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// MemberRow — one vault member with optional revoke
// ---------------------------------------------------------------------------

interface MemberMeta {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  memberSince: string;
}

function MemberRow({
  member,
  vaultId,
  canManage,
  membersCount,
}: {
  member: MemberMeta;
  vaultId: string;
  canManage: boolean;
  membersCount: number;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const removeMember = useRemoveMember();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleRevoke() {
    setBusy(true);
    try {
      await removeMember.mutateAsync({ vaultId, userId: member.userId });
      toast.success(t("members.revoked", { name: `${member.firstName} ${member.lastName}` }));
      setConfirmOpen(false);
    } catch (err) {
      notifyError(err, t("members.revokeError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-lg bg-card p-3 ring-1 ring-foreground/10">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground">
        {member.firstName[0]}{member.lastName[0]}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.firstName} {member.lastName}
        </p>
        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
      </div>

      {canManage ? (
        <>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            title={t("members.revoke")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            disabled={membersCount <= 1}
          >
            <UserMinusIcon className="size-4" aria-hidden />
          </button>

          {/* Revoke confirm */}
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{t("members.revokeTitle")}</DialogTitle>
                <DialogDescription>
                  {t("members.revokeDescription", {
                    name: `${member.firstName} ${member.lastName}`,
                  })}
                </DialogDescription>
              </DialogHeader>
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
                {t("members.revokeSemanticNote")}
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmOpen(false)}
                  disabled={busy}
                >
                  {tc("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleRevoke}
                  disabled={busy}
                >
                  {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
                  {t("members.revoke")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// AddItemDialog
// ---------------------------------------------------------------------------

function AddItemDialog({
  open,
  onOpenChange,
  vaultId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { ensureDek } = useVaultDek(vaultId);
  const createItem = useCreateItem();
  const [label, setLabel] = useState("");
  const [handle, setHandle] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setLabel("");
    setHandle("");
    setValue("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !label.trim() || !handle.trim() || !value) return;
    const dek = ensureDek();
    if (!dek) {
      toast.error(t("items.dekUnavailable"));
      return;
    }
    setBusy(true);
    try {
      // Seal the plaintext value in the browser — never send it.
      const envelope = sealItem(dek, value);
      await createItem.mutateAsync({
        vaultId,
        data: {
          label: label.trim(),
          handle: handle.trim(),
          ...envelope,
        },
      });
      toast.success(t("items.created", { label: label.trim() }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("items.createError"));
    } finally {
      // Drop the entered value from state as soon as the mutation resolves,
      // regardless of success or failure — plaintext never lingers.
      setValue("");
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("items.addTitle")}</DialogTitle>
          <DialogDescription>{t("items.addDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="item-label">{t("items.labelField")}</FieldLabel>
            <Input
              id="item-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              maxLength={200}
              placeholder={t("items.labelPlaceholder")}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="item-handle">{t("items.handleField")}</FieldLabel>
            <Input
              id="item-handle"
              value={handle}
              onChange={(e) =>
                setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))
              }
              disabled={busy}
              maxLength={80}
              placeholder={t("items.handlePlaceholder")}
              className="font-mono"
            />
            <FieldDescription>{t("items.handleHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="item-value">{t("items.valueField")}</FieldLabel>
            <Input
              id="item-value"
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              placeholder={t("items.valuePlaceholder")}
            />
            <FieldDescription>{t("items.valueHint")}</FieldDescription>
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !label.trim() || !handle.trim() || !value}
            >
              {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
              {busy ? t("items.creating") : t("items.addSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// EditItemDialog
// ---------------------------------------------------------------------------

function EditItemDialog({
  open,
  onOpenChange,
  vaultId,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
  item: SecretItem;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { ensureDek } = useVaultDek(vaultId);
  const updateItem = useUpdateItem();
  const [label, setLabel] = useState(item.label);
  const [handle, setHandle] = useState(item.handle);
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Sync fields when the item prop changes (re-open for different item).
  useEffect(() => {
    setLabel(item.label);
    setHandle(item.handle);
    setNewValue("");
  }, [item.id, item.label, item.handle]);

  function handleOpenChange(next: boolean) {
    if (!next) setNewValue("");
    onOpenChange(next);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      // Build partial update — envelope only if a new value was entered.
      type PatchData = {
        label?: string;
        handle?: string;
        ciphertext?: string;
        iv?: string;
        authTag?: string;
        keyVersion?: number;
      };
      const patch: PatchData = {};
      if (label.trim() && label.trim() !== item.label) patch.label = label.trim();
      if (handle.trim() && handle.trim() !== item.handle) patch.handle = handle.trim();
      if (newValue) {
        const dek = ensureDek();
        if (!dek) {
          toast.error(t("items.dekUnavailable"));
          setBusy(false);
          return;
        }
        const envelope = sealItem(dek, newValue);
        Object.assign(patch, envelope);
      }

      if (Object.keys(patch).length === 0) {
        handleOpenChange(false);
        return;
      }

      await updateItem.mutateAsync({ vaultId, itemId: item.id, data: patch });
      toast.success(t("items.updated", { label: label.trim() || item.label }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("items.updateError"));
    } finally {
      setNewValue("");
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("items.editTitle")}</DialogTitle>
          <DialogDescription>{t("items.editDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleUpdate} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="edit-item-label">{t("items.labelField")}</FieldLabel>
            <Input
              id="edit-item-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              maxLength={200}
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-item-handle">{t("items.handleField")}</FieldLabel>
            <Input
              id="edit-item-handle"
              value={handle}
              onChange={(e) =>
                setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))
              }
              disabled={busy}
              maxLength={80}
              className="font-mono"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-item-value">{t("items.newValueField")}</FieldLabel>
            <Input
              id="edit-item-value"
              type="password"
              autoComplete="new-password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              disabled={busy}
              placeholder={t("items.newValuePlaceholder")}
            />
            <FieldDescription>{t("items.newValueHint")}</FieldDescription>
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!label.trim() && !newValue)}>
              {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
              {busy ? t("items.updating") : tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DeleteItemDialog
// ---------------------------------------------------------------------------

function DeleteItemDialog({
  open,
  onOpenChange,
  vaultId,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
  item: SecretItem;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const deleteItem = useDeleteItem();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteItem.mutateAsync({ vaultId, itemId: item.id });
      toast.success(t("items.deleted", { label: item.label }));
      onOpenChange(false);
    } catch (err) {
      notifyError(err, t("items.deleteError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("items.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("items.deleteDescription", { label: item.label })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {tc("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={busy}>
            {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
            {tc("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AddMemberDialog — pick a user → wrap DEK to their public key → grant
// ---------------------------------------------------------------------------

function AddMemberDialog({
  open,
  onOpenChange,
  vaultId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { getPrivateKey } = useSecretSession();
  const { membership } = useVaultDek(vaultId);
  const { data: myMembership } = useMyMembership(vaultId);
  const addMember = useAddMember();

  const { data: allUsers, isLoading: usersLoading } = useUsers();
  const { data: currentMembers } = useMembers(vaultId);

  const [targetUserId, setTargetUserId] = useState("");
  const [busy, setBusy] = useState(false);

  // Fetch the target's public key only when a user is selected.
  const { data: targetPublicKeyData, isLoading: publicKeyLoading } =
    useUserPublicKey(targetUserId || undefined);

  function handleOpenChange(next: boolean) {
    if (!next) setTargetUserId("");
    onOpenChange(next);
  }

  // Filter out users who are already members.
  const memberUserIds = new Set(currentMembers?.map((m) => m.userId) ?? []);
  const eligibleUsers = allUsers?.filter((u) => !memberUserIds.has(u.id)) ?? [];

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !targetUserId || !targetPublicKeyData) return;

    const privateKey = getPrivateKey();
    const mship = myMembership ?? membership;
    if (!privateKey || !mship) {
      toast.error(t("members.grantDekUnavailable"));
      return;
    }

    setBusy(true);
    try {
      // "No grant-what-you-can't-read": wrapDekForMember FIRST unwraps the DEK from
      // our own membership (proving we hold it), THEN wraps it to the target's pubkey.
      const targetPubKeyBytes = base64ToBytes(targetPublicKeyData.publicKey);
      const wrappedDek = wrapDekForMember(privateKey, mship, targetPubKeyBytes);

      await addMember.mutateAsync({
        vaultId,
        data: { userId: targetUserId, ...wrappedDek },
      });

      const targetUser = eligibleUsers.find((u) => u.id === targetUserId);
      const targetName = targetUser
        ? `${targetUser.firstName} ${targetUser.lastName}`
        : targetUserId;
      toast.success(t("members.granted", { name: targetName }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("members.grantError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("members.addTitle")}</DialogTitle>
          <DialogDescription>{t("members.addDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleGrant} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="grant-user">{t("members.userLabel")}</FieldLabel>
            {usersLoading ? (
              <div className="h-9 animate-pulse rounded-md bg-muted" />
            ) : (
              <select
                id="grant-user"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                disabled={busy}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t("members.selectUser")}</option>
                {eligibleUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName} ({u.email})
                  </option>
                ))}
              </select>
            )}
            {targetUserId && !publicKeyLoading && !targetPublicKeyData ? (
              <FieldDescription className="text-destructive">
                {t("members.noPublicKey")}
              </FieldDescription>
            ) : null}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !targetUserId ||
                publicKeyLoading ||
                !targetPublicKeyData
              }
            >
              {busy || publicKeyLoading ? (
                <ArrowPathIcon className="size-4 animate-spin" />
              ) : null}
              {busy ? t("members.granting") : t("members.grantSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ItemsSkeleton() {
  return (
    <ul className="space-y-2">
      {["a", "b", "c"].map((k) => (
        <li key={k} className="flex items-center gap-3 rounded-lg border p-3">
          <div className="size-8 animate-pulse rounded-md bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function MembersSkeleton() {
  return (
    <ul className="space-y-2">
      {["a", "b"].map((k) => (
        <li key={k} className="flex items-center gap-3 rounded-lg border p-3">
          <div className="size-8 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}
