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
} from "@heroicons/react/24/outline";
import type { SecretItem, User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
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
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { useUsers } from "@/lib/api/hooks/use-users";
import { copyText } from "@/lib/secret-manager/clipboard";
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
 * Classify the caller's vault-membership query (SECW-02). A 404 means the caller is NOT a member of this
 * vault (e.g. an ADMIN browsing it) — distinct from a still-loading query or a genuine load error. Keeping
 * these apart lets the UI show a clear "you are not a member" state instead of a generic reveal error.
 */
type MembershipState = "loading" | "member" | "not-member" | "error";

function classifyMembership(q: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
}): MembershipState {
  if (q.isLoading) return "loading";
  if (q.data) return "member";
  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return "not-member";
  if (q.isError) return "error";
  // No data, no error, not loading — treat as still settling.
  return "loading";
}

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
  // SECW-02: surface a vault-level "you are not a member" banner above the items so a non-member ADMIN
  // understands why values cannot be decrypted, instead of hitting a generic per-row reveal error.
  const membershipState = classifyMembership(useMyMembership(vaultId));

  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  return (
    // #616: cap the content to a centered column matching the app's other detail views
    // (users/applications/locations all use `mx-auto max-w-4xl`). A secret row is a compact object;
    // letting it span a wide monitor reads poorly and leaves the screen feeling empty. The column
    // keeps one-item and many-item vaults both looking intentional. Frontend-only — no change to the
    // decrypt/data flow.
    <div className="mx-auto max-w-4xl space-y-8">
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

        {/* SECW-02: non-member (e.g. ADMIN) banner — values in this vault cannot be decrypted. */}
        {membershipState === "not-member" ? (
          <Callout tone="warning" className="text-xs">
            {t("detail.notMember")}
          </Callout>
        ) : null}

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
          <Callout tone="warning" className="text-xs">
            {t("members.singleMemberWarning")}
          </Callout>
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
  const { isUnlocked } = useSecretSession();
  // SECW-02: read the caller's membership directly so we can distinguish "not a member" (404, e.g. a
  // non-member ADMIN) and "still loading" from a genuine decrypt failure — revealError is reserved for
  // real tamper / wrong-DEK cases only.
  const membershipQuery = useMyMembership(vaultId);
  const membershipState = classifyMembership(membershipQuery);

  // SECURITY: plaintext lives ONLY in this local state. Never put it in a query key,
  // localStorage, or prop. Auto-clear after REVEAL_TIMEOUT_MS.
  const [plaintext, setPlaintext] = useState<string | undefined>(undefined);
  const [revealError, setRevealError] = useState(false);
  const [copied, setCopied] = useState(false);
  // SECW-06: a copy attempt failed (insecure context — no clipboard API). Prompt manual copy.
  const [copyFailed, setCopyFailed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup the auto-mask timer on unmount.
  useEffect(() => () => clearTimeout(maskTimerRef.current), []);

  // SECW-04 (lens1): when the session locks (isUnlocked → false), immediately cancel the pending auto-mask
  // timer and re-mask any revealed value. An explicit Lock must re-hide every revealed item at once.
  useEffect(() => {
    if (!isUnlocked) {
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
      setCopyFailed(false);
    }
  }, [isUnlocked]);

  const handleReveal = useCallback(() => {
    if (plaintext !== undefined) {
      // Second click → mask immediately.
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
      setCopyFailed(false);
      return;
    }
    // SM-WEB-07: re-clicking reveal clears any lingering error so it never sticks as a dead state.
    setRevealError(false);
    const dek = ensureDek();
    if (!dek) {
      // SECW-02: not a genuine decrypt failure — the DEK is unavailable because membership is missing,
      // still loading, or the session is locked. Those are surfaced via dedicated states below, so we
      // deliberately do NOT set revealError here (that is reserved for tamper / wrong-DEK).
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

  async function handleCopy() {
    if (!plaintext) return;
    // SECW-06: copyText reports failure (insecure context — no clipboard API) instead of silently
    // no-opping. On failure, prompt the user to select & copy the value manually (it is `select-all`).
    const ok = await copyText(plaintext);
    if (ok) {
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyFailed(true);
    }
  }

  // a11y (#606): the reveal/mask action's label depends on membership + reveal state. Compute it once so
  // both `title` (hover tooltip) and `aria-label` (accessible name) share a single source of truth.
  const revealLabel =
    membershipState === "not-member"
      ? t("items.notMember")
      : membershipState === "loading"
        ? t("items.preparingKey")
        : plaintext !== undefined
          ? t("items.mask")
          : t("items.reveal");

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
                aria-label={t("items.copy")}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-pillar-knowledge" aria-hidden />
                ) : (
                  <ClipboardIcon className="size-3.5" aria-hidden />
                )}
              </button>
              {/* SECW-06: clipboard unavailable (insecure context). Prompt manual copy — the value
                  above is `select-all`, so a manual selection still works. */}
              {copyFailed ? (
                <span className="text-xs text-destructive">{t("items.copyFailed")}</span>
              ) : null}
            </>
          ) : revealError ? (
            // SM-WEB-07: pair the genuine decrypt error with a retry affordance so it is never a dead end.
            <span className="flex items-center gap-2">
              <span className="text-xs text-destructive">{t("items.revealError")}</span>
              <button
                type="button"
                onClick={handleReveal}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {t("items.revealRetry")}
              </button>
            </span>
          ) : membershipState === "not-member" ? (
            <span className="text-xs text-destructive">{t("items.notMember")}</span>
          ) : membershipState === "error" ? (
            <span className="text-xs text-destructive">{t("detail.membershipError")}</span>
          ) : membershipState === "loading" ? (
            <span className="text-xs text-muted-foreground">{t("items.preparingKey")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{"•".repeat(16)}</span>
          )}
        </div>
      </div>

      {/* Row actions */}
      <div className="flex shrink-0 items-center gap-1">
        {/* a11y (#606): icon-only button — carry the same i18n string in `aria-label` so screen-reader
            and keyboard users get a name (a `title` alone is not a reliable accessible name). */}
        <button
          type="button"
          onClick={handleReveal}
          disabled={membershipState !== "member"}
          title={revealLabel}
          aria-label={revealLabel}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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
              aria-label={t("items.edit")}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PencilIcon className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              title={t("items.delete")}
              aria-label={t("items.delete")}
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
            // SM-WEB-06: explain WHY the button is disabled when it's the last member, instead of the stale
            // "Remove access" tooltip that implies the action is available.
            // a11y (#606): mirror the same string into `aria-label` so this icon-only button has a name.
            title={membersCount <= 1 ? t("members.cannotRemoveLast") : t("members.revoke")}
            aria-label={membersCount <= 1 ? t("members.cannotRemoveLast") : t("members.revoke")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
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
              <Callout tone="warning" className="text-xs">
                {t("members.revokeSemanticNote")}
              </Callout>
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
  // SM-WEB-05: know whether the vault key is still being prepared vs genuinely unavailable, so we can
  // disable submit with a "preparing…" hint instead of firing and dropping the user's typed plaintext.
  const membershipState = classifyMembership(useMyMembership(vaultId));
  const createItem = useCreateItem();
  const [label, setLabel] = useState("");
  const [handle, setHandle] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // SM-WEB-05: inline actionable error when the DEK cannot be unwrapped — the session can be re-driven
  // (lock + unlock) and the typed value is preserved so nothing is lost mid-edit.
  const [keyError, setKeyError] = useState(false);

  const preparingKey = membershipState === "loading";

  function reset() {
    setLabel("");
    setHandle("");
    setValue("");
    setKeyError(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || preparingKey || !label.trim() || !handle.trim() || !value) return;
    const dek = ensureDek();
    if (!dek) {
      // Genuinely can't unwrap — keep the typed value, surface an inline recoverable error, do NOT toast
      // a dead-end. The user can lock + unlock and retry without losing their entry.
      setKeyError(true);
      return;
    }
    setKeyError(false);
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
              onChange={(e) => {
                setValue(e.target.value);
                if (keyError) setKeyError(false);
              }}
              disabled={busy}
              placeholder={t("items.valuePlaceholder")}
            />
            {keyError ? (
              <FieldDescription className="text-destructive">
                {t("items.dekUnavailableInline")}
              </FieldDescription>
            ) : preparingKey ? (
              <FieldDescription>{t("items.preparingKey")}</FieldDescription>
            ) : (
              <FieldDescription>{t("items.valueHint")}</FieldDescription>
            )}
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
              disabled={busy || preparingKey || !label.trim() || !handle.trim() || !value}
            >
              {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
              {busy ? t("items.creating") : preparingKey ? t("items.preparingKey") : t("items.addSubmit")}
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
  // SM-WEB-05: distinguish "vault key still preparing" from "genuinely unavailable" so we never strand the
  // user mid-edit with their typed new value silently dropped.
  const membershipState = classifyMembership(useMyMembership(vaultId));
  const updateItem = useUpdateItem();
  const [label, setLabel] = useState(item.label);
  const [handle, setHandle] = useState(item.handle);
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState(false);

  const preparingKey = membershipState === "loading";
  // Only the value path needs the DEK; label/handle-only edits work without it.
  const needsKey = newValue.length > 0;

  // Sync fields when the item prop changes (re-open for different item).
  useEffect(() => {
    setLabel(item.label);
    setHandle(item.handle);
    setNewValue("");
    setKeyError(false);
  }, [item.id, item.label, item.handle]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setNewValue("");
      setKeyError(false);
    }
    onOpenChange(next);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || (needsKey && preparingKey)) return;
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

    if (needsKey) {
      const dek = ensureDek();
      if (!dek) {
        // Genuinely can't unwrap — surface an inline recoverable error and PRESERVE the typed value.
        // The user can lock + unlock and retry; we never drop their entry on this path.
        setKeyError(true);
        return;
      }
      const envelope = sealItem(dek, newValue);
      Object.assign(patch, envelope);
    }

    if (Object.keys(patch).length === 0) {
      handleOpenChange(false);
      return;
    }

    setKeyError(false);
    setBusy(true);
    try {
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
              onChange={(e) => {
                setNewValue(e.target.value);
                if (keyError) setKeyError(false);
              }}
              disabled={busy}
              placeholder={t("items.newValuePlaceholder")}
            />
            {keyError ? (
              <FieldDescription className="text-destructive">
                {t("items.dekUnavailableInline")}
              </FieldDescription>
            ) : needsKey && preparingKey ? (
              <FieldDescription>{t("items.preparingKey")}</FieldDescription>
            ) : (
              <FieldDescription>{t("items.newValueHint")}</FieldDescription>
            )}
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
              disabled={busy || (needsKey && preparingKey) || (!label.trim() && !newValue)}
            >
              {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
              {busy ? t("items.updating") : needsKey && preparingKey ? t("items.preparingKey") : tc("save")}
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

/**
 * AddMemberDialog — the OUTER shell. SM-FE-004: the grant flow pulls the WHOLE user directory
 * (`useUsers`) plus this vault's membership/members queries. Those used to fire on vault-detail mount even
 * while the dialog was closed, because the heavy hooks lived on this always-mounted component. We now keep
 * the hooks in {@link AddMemberDialogBody} and mount the body ONLY when `open` is true — so nothing fetches
 * until the admin actually opens the grant dialog. The dialog chrome (title/description) stays in the shell
 * so the open/close transition is unaffected.
 */
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("members.addTitle")}</DialogTitle>
          <DialogDescription>{t("members.addDescription")}</DialogDescription>
        </DialogHeader>
        {/* Gate the data hooks behind `open` — the body (and its useUsers/useMembers/useMyMembership/
            useUserPublicKey queries) only mounts once the dialog is open. */}
        {open ? <AddMemberDialogBody vaultId={vaultId} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The grant form + its data hooks. Mounted only while the dialog is open (SM-FE-004). */
function AddMemberDialogBody({
  vaultId,
  onClose,
}: {
  vaultId: string;
  onClose: () => void;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { getPrivateKey } = useSecretSession();
  const { membership } = useVaultDek(vaultId);
  const { data: myMembership } = useMyMembership(vaultId);
  const addMember = useAddMember();

  // SM-WEB-02: read isError so a users load error is NOT indistinguishable from "no one to add".
  const { data: allUsers, isLoading: usersLoading, isError: usersLoadError } = useUsers();
  const { data: currentMembers } = useMembers(vaultId);

  const [targetUserId, setTargetUserId] = useState("");
  const [busy, setBusy] = useState(false);

  // Fetch the target's public key only when a user is selected.
  // SECW-03: surface a 404 (target never bootstrapped their Secret Manager) distinctly from any other error.
  const {
    data: targetPublicKeyData,
    isLoading: publicKeyLoading,
    isError: publicKeyError,
    error: publicKeyErrorObj,
  } = useUserPublicKey(targetUserId || undefined);

  // Filter out users who are already members.
  const memberUserIds = new Set(currentMembers?.map((m) => m.userId) ?? []);
  const eligibleUsers: User[] = allUsers?.filter((u: User) => !memberUserIds.has(u.id)) ?? [];

  // SM-WEB-02: with users loaded successfully but nobody left to add, show an explicit empty state and
  // disable Grant — instead of a dead <select> with only the placeholder option.
  const noEligible = !usersLoading && !usersLoadError && eligibleUsers.length === 0;
  // SECW-03: a 404 on the target's public key means they never bootstrapped; any other resolved-empty key
  // is a different failure. Both block the grant, but the 404 gets a clear, actionable message.
  const targetNoKeypair =
    !!targetUserId &&
    !publicKeyLoading &&
    publicKeyError &&
    publicKeyErrorObj instanceof ApiError &&
    publicKeyErrorObj.status === 404;

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

      const targetUser = eligibleUsers.find((u: User) => u.id === targetUserId);
      const targetName = targetUser
        ? `${targetUser.firstName} ${targetUser.lastName}`
        : targetUserId;
      toast.success(t("members.granted", { name: targetName }));
      onClose();
    } catch (err) {
      notifyError(err, t("members.grantError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleGrant} className="space-y-4">
      <Field>
        <FieldLabel htmlFor="grant-user">{t("members.userLabel")}</FieldLabel>
        {usersLoading ? (
          <div className="h-9 animate-pulse rounded-md bg-muted" />
        ) : usersLoadError ? (
          // SM-WEB-02: a load error must be distinct from "no one to add".
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {t("members.usersLoadError")}
          </p>
        ) : noEligible ? (
          // SM-WEB-02: explicit empty state instead of a dead <select> with only the placeholder.
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {t("members.noEligible")}
          </p>
        ) : (
          <select
            id="grant-user"
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            disabled={busy}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">{t("members.selectUser")}</option>
            {eligibleUsers.map((u: User) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName} ({u.email})
              </option>
            ))}
          </select>
        )}
        {targetUserId && !publicKeyLoading && !targetPublicKeyData ? (
          <FieldDescription className="text-destructive">
            {/* SECW-03: a 404 means the target never bootstrapped — give an actionable message;
                any other resolved-empty key keeps the generic note. */}
            {targetNoKeypair ? t("members.targetNoKeypair") : t("members.noPublicKey")}
          </FieldDescription>
        ) : null}
      </Field>

      {!usersLoading && !usersLoadError && !noEligible ? (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {tc("cancel")}
          </Button>
          <Button
            type="submit"
            disabled={busy || !targetUserId || publicKeyLoading || !targetPublicKeyData}
          >
            {busy || publicKeyLoading ? (
              <ArrowPathIcon className="size-4 animate-spin" />
            ) : null}
            {busy ? t("members.granting") : t("members.grantSubmit")}
          </Button>
        </DialogFooter>
      ) : (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {tc("cancel")}
          </Button>
        </DialogFooter>
      )}
    </form>
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
