"use client";

import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  ClipboardIcon,
  CpuChipIcon,
  EyeIcon,
  EyeSlashIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type {
  SecretItem,
  SecretItemKind,
  ServiceAccount,
  User,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { SearchInput } from "@/components/search-input";
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
import { useServiceAccounts } from "@/lib/api/hooks/use-service-accounts";
import { useUsers } from "@/lib/api/hooks/use-users";
import {
  CLIPBOARD_CLEAR_MS,
  copyTextWithAutoClear,
} from "@/lib/secret-manager/clipboard";
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
import {
  useAddServiceAccountMember,
  useRemoveServiceAccountMember,
  useServiceAccountPublicKey,
} from "@/lib/secret-manager/hooks/use-service-account-members";
import { useUserPublicKey } from "@/lib/secret-manager/hooks/use-keypair";
import { useRecordExport, useVault } from "@/lib/secret-manager/hooks/use-vaults";
import {
  type EnvEntry,
  parseEnv,
  serializeEnv,
  splitNewVsExisting,
} from "@/lib/secret-manager/env-file";
import { encodeSecretPayload } from "@/lib/secret-manager/typed-secret";
import { base64ToBytes } from "./crypto-bytes";
import { SecretKindIcon } from "./secret-kind";
import { useSecretSession } from "./secret-session";
import {
  buildTypedSecret,
  isTypedSecretComplete,
  TypedSecretFields,
  type TypedSecretFieldValues,
} from "./typed-secret-fields";
import { TypedSecretReveal } from "./typed-secret-reveal";
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

// ---------------------------------------------------------------------------
// Local reducers (grouped useState → useReducer; prefer-useReducer). Pure STATE
// GROUPING only — no change to the crypto open/seal chain, the async ordering, or
// the error surface. The zero-knowledge line holds: plaintext (`value`/`newValue`)
// is kept in its OWN dedicated useState in the dialogs, NEVER folded into a reducer.
// ---------------------------------------------------------------------------

/** VaultDetail's independent dialog-open booleans. */
type VaultDialog =
  | "addItem"
  | "addMember"
  | "addServiceAccount"
  | "export"
  | "import";
type VaultDialogsState = Record<VaultDialog, boolean>;
function vaultDialogsReducer(
  state: VaultDialogsState,
  action: { dialog: VaultDialog; open: boolean },
): VaultDialogsState {
  return { ...state, [action.dialog]: action.open };
}

/** ItemRow's edit/delete dialog booleans (the reveal/copy state stays its own useState, untouched). */
type RowDialogsState = { editOpen: boolean; deleteOpen: boolean };
type RowDialogsAction =
  | { type: "setEditOpen"; open: boolean }
  | { type: "setDeleteOpen"; open: boolean };
function rowDialogsReducer(
  state: RowDialogsState,
  action: RowDialogsAction,
): RowDialogsState {
  switch (action.type) {
    case "setEditOpen":
      return { ...state, editOpen: action.open };
    case "setDeleteOpen":
      return { ...state, deleteOpen: action.open };
  }
}

/** AddItemDialog's non-secret form chrome (label/handle + submission status). The plaintext `value`
 *  is deliberately kept OUT of here, in its own useState. `reset` clears the fields but not `busy`,
 *  exactly like the original reset(). */
type AddItemFormState = {
  label: string;
  handle: string;
  busy: boolean;
  keyError: boolean;
};
type AddItemFormAction =
  | { type: "setLabel"; value: string }
  | { type: "setHandle"; value: string }
  | { type: "setBusy"; busy: boolean }
  | { type: "setKeyError"; keyError: boolean }
  | { type: "reset" };
function addItemFormReducer(
  state: AddItemFormState,
  action: AddItemFormAction,
): AddItemFormState {
  switch (action.type) {
    case "setLabel":
      return { ...state, label: action.value };
    case "setHandle":
      return { ...state, handle: action.value };
    case "setBusy":
      return { ...state, busy: action.busy };
    case "setKeyError":
      return { ...state, keyError: action.keyError };
    case "reset":
      return { ...state, label: "", handle: "", keyError: false };
  }
}

/** EditItemDialog's non-secret form chrome (label/handle + submission status). The plaintext `newValue`
 *  and the `lastItemId` render-sync tracker stay their own useState — `lastItemId` keeps the
 *  set-state-in-render tracker pattern intact. `syncItem` mirrors the item-change reset (label/handle/
 *  keyError; busy is intentionally left as-is, like the original). */
type EditItemFormState = {
  label: string;
  handle: string;
  busy: boolean;
  keyError: boolean;
};
type EditItemFormAction =
  | { type: "setLabel"; value: string }
  | { type: "setHandle"; value: string }
  | { type: "setBusy"; busy: boolean }
  | { type: "setKeyError"; keyError: boolean }
  | { type: "syncItem"; item: SecretItem };
function editItemFormReducer(
  state: EditItemFormState,
  action: EditItemFormAction,
): EditItemFormState {
  switch (action.type) {
    case "setLabel":
      return { ...state, label: action.value };
    case "setHandle":
      return { ...state, handle: action.value };
    case "setBusy":
      return { ...state, busy: action.busy };
    case "setKeyError":
      return { ...state, keyError: action.keyError };
    case "syncItem":
      return {
        ...state,
        label: action.item.label,
        handle: action.item.handle,
        keyError: false,
      };
  }
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

  const [dialogs, dispatchDialogs] = useReducer(vaultDialogsReducer, {
    addItem: false,
    addMember: false,
    addServiceAccount: false,
    export: false,
    import: false,
  });
  const {
    addItem: addItemOpen,
    addMember: addMemberOpen,
    addServiceAccount: addServiceAccountOpen,
    export: exportOpen,
    import: importOpen,
  } = dialogs;
  // #609: client-side filter over the NON-SECRET metadata (label + handle) only — never the value
  // (which is ciphertext until revealed). INV-10 preserved: no plaintext is ever a filter input.
  const [query, setQuery] = useState("");

  const filteredItems = useMemo(() => {
    if (!items) return items;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) || it.handle.toLowerCase().includes(q),
    );
  }, [items, query]);

  const hasItems = !!items && items.length > 0;

  // Stable element for the PageHeader `breadcrumb` slot (jsx-no-jsx-as-prop).
  const breadcrumb = useMemo(
    () => (
      <Link
        href="/secrets"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        {t("list.title")}
      </Link>
    ),
    [t],
  );

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
        breadcrumb={breadcrumb}
        actions={
          canManage ? (
            <Button
              size="sm"
              onClick={() => dispatchDialogs({ dialog: "addItem", open: true })}
            >
              <PlusIcon className="size-4" />
              {t("items.addItem")}
            </Button>
          ) : null
        }
      />

      {/* Items section */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t("items.sectionTitle")}</h2>
          {/* Export/import are deliberate, occasional admin actions — kept secondary and out of the
              primary "Add secret" path. Import is manager-gated; export needs only a readable vault. */}
          <div className="flex items-center gap-2">
            {membershipState === "member" && hasItems ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatchDialogs({ dialog: "export", open: true })}
              >
                <ArrowDownTrayIcon className="size-4" />
                {t("export.trigger")}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatchDialogs({ dialog: "import", open: true })}
              >
                <ArrowUpTrayIcon className="size-4" />
                {t("import.trigger")}
              </Button>
            ) : null}
          </div>
        </div>

        {/* SECW-02: non-member (e.g. ADMIN) banner — values in this vault cannot be decrypted. */}
        {membershipState === "not-member" ? (
          <Callout tone="warning" className="text-xs">
            {t("detail.notMember")}
          </Callout>
        ) : null}

        {/* #609: client-side search over label/handle (non-secret metadata). Only when it earns its
            place — a vault with a handful of items doesn't need a filter box. */}
        {hasItems && (items?.length ?? 0) > 4 ? (
          <SearchInput
            value={query}
            onChange={setQuery}
            label={t("items.searchLabel")}
            placeholder={t("items.searchPlaceholder")}
          />
        ) : null}

        {itemsLoading ? (
          <ItemsSkeleton />
        ) : !items || items.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("items.empty")}
          </div>
        ) : filteredItems && filteredItems.length === 0 ? (
          // #609: empty-search state (localized) — distinct from the no-items-at-all state above.
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t("items.searchEmpty", { query: query.trim() })}
          </div>
        ) : (
          // ponytail: the items list IS a ledger — one card, hairline-divided rows (ADR-0077),
          // not a stack of separately-ringed mini-cards.
          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {(filteredItems ?? []).map((item) => (
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
            <div className="flex items-center gap-2">
              {/* ADR-0080: grant a service account programmatic read of this vault (machine member). */}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  dispatchDialogs({ dialog: "addServiceAccount", open: true })
                }
              >
                <CpuChipIcon className="size-4" />
                {t("serviceAccountMembers.addAction")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => dispatchDialogs({ dialog: "addMember", open: true })}
              >
                <UserPlusIcon className="size-4" />
                {t("members.addMember")}
              </Button>
            </div>
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
          // ponytail: members as a ledger too — hairline-divided rows in one card (ADR-0077).
          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
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
            onOpenChange={(open) => dispatchDialogs({ dialog: "addItem", open })}
            vaultId={vaultId}
          />
          <AddMemberDialog
            open={addMemberOpen}
            onOpenChange={(open) => dispatchDialogs({ dialog: "addMember", open })}
            vaultId={vaultId}
          />
          <AddServiceAccountDialog
            open={addServiceAccountOpen}
            onOpenChange={(open) =>
              dispatchDialogs({ dialog: "addServiceAccount", open })
            }
            vaultId={vaultId}
          />
          {/* #613: bulk import — manager-gated (it creates items). Mounted only while open. */}
          {importOpen ? (
            <ImportDialog
              open={importOpen}
              onOpenChange={(open) => dispatchDialogs({ dialog: "import", open })}
              vaultId={vaultId}
              vaultName={vault?.name ?? t("detail.unknownVault")}
              existingItems={items ?? []}
            />
          ) : null}
        </>
      ) : null}
      {/* #612: export — available to any vault MEMBER (not gated on manage); the browser already holds
          the DEK. Mounted only while open. */}
      {exportOpen ? (
        <ExportDialog
          open={exportOpen}
          onOpenChange={(open) => dispatchDialogs({ dialog: "export", open })}
          vaultId={vaultId}
          vaultName={vault?.name ?? t("detail.unknownVault")}
          items={items ?? []}
        />
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
  // Edit/delete dialog open-state — grouped (the reveal/copy state above stays its own useState).
  const [rowDialogs, dispatchRowDialogs] = useReducer(rowDialogsReducer, {
    editOpen: false,
    deleteOpen: false,
  });
  const { editOpen, deleteOpen } = rowDialogs;
  const maskTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // #607: cancel handle for the pending best-effort clipboard auto-clear from the last copy.
  const clipboardClearRef = useRef<(() => void) | undefined>(undefined);

  // Cleanup the auto-mask timer + any pending clipboard auto-clear on unmount.
  useEffect(
    () => () => {
      clearTimeout(maskTimerRef.current);
      clipboardClearRef.current?.();
    },
    [],
  );

  // SECW-04 (lens1): when the session locks (isUnlocked → false), immediately cancel the pending auto-mask
  // timer and re-mask any revealed value. An explicit Lock must re-hide every revealed item at once.
  /* eslint-disable react-hooks/set-state-in-effect -- reacting to external session-lock event; clearTimeout side-effect requires an effect */
  useEffect(() => {
    if (!isUnlocked) {
      clearTimeout(maskTimerRef.current);
      setPlaintext(undefined);
      setCopyFailed(false);
    }
  }, [isUnlocked]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    // #607: copy, then schedule a BEST-EFFORT clipboard auto-clear (compare-then-clear) so the plaintext
    // does not linger in the OS clipboard indefinitely — mirroring the on-screen auto-mask posture.
    // SECW-06: the helper still reports failure (insecure context — no clipboard API) instead of silently
    // no-opping. On failure, prompt the user to select & copy the value manually (it is `select-all`).
    clipboardClearRef.current?.(); // cancel any prior pending clear before re-arming
    const { ok, cancel } = await copyTextWithAutoClear(plaintext);
    if (ok) {
      clipboardClearRef.current = cancel;
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
    <li className="flex items-center gap-3 p-3">
      {/* The structural-kind glyph (ADR-0075) — server-visible metadata, no decryption needed. */}
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-pillar-knowledge/10 text-pillar-knowledge">
        <SecretKindIcon kind={item.kind} className="size-4" aria-hidden />
      </span>

      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{item.label}</span>
          {item.kind !== "GENERIC" ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              {t(`kinds.${item.kind}`)}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground font-mono">{item.handle}</p>

        {/* Value area */}
        <div className="mt-1.5">
          {plaintext !== undefined ? (
            item.kind === "GENERIC" ? (
              <div className="flex items-center gap-2">
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
                {/* #607: a subtle "copied — clears in Ns" hint. The clear is best-effort (see
                    clipboard.ts); this signals the intent without promising a guarantee. */}
                {copied ? (
                  <span className="text-xs text-muted-foreground">
                    {t("items.copiedClears", { seconds: CLIPBOARD_CLEAR_MS / 1000 })}
                  </span>
                ) : null}
                {/* SECW-06: clipboard unavailable (insecure context). Prompt manual copy — the value
                    above is `select-all`, so a manual selection still works. */}
                {copyFailed ? (
                  <span className="text-xs text-destructive">{t("items.copyFailed")}</span>
                ) : null}
              </div>
            ) : (
              // ADR-0075: typed render (SSH key / TOTP live code / certificate). The component parses
              // the already-decrypted plaintext by `kind` and degrades a legacy value to a raw block.
              <TypedSecretReveal kind={item.kind} plaintext={plaintext} />
            )
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
              onClick={() => dispatchRowDialogs({ type: "setEditOpen", open: true })}
              title={t("items.edit")}
              aria-label={t("items.edit")}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PencilIcon className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => dispatchRowDialogs({ type: "setDeleteOpen", open: true })}
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
        onOpenChange={(open) => dispatchRowDialogs({ type: "setEditOpen", open })}
        vaultId={vaultId}
        item={item}
      />

      {/* Delete confirm dialog */}
      <DeleteItemDialog
        open={deleteOpen}
        onOpenChange={(open) => dispatchRowDialogs({ type: "setDeleteOpen", open })}
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
    <li className="flex items-center gap-3 p-3">
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
  const [form, dispatchForm] = useReducer(addItemFormReducer, {
    label: "",
    handle: "",
    busy: false,
    keyError: false,
  });
  const { label, handle, busy, keyError } = form;
  // Zero-knowledge: the typed plaintext fields live in their OWN dedicated state (ADR-0075), never folded
  // into the form reducer. Cleared in the mutation's finally (below) and on reset — success or failure.
  const [kind, setKind] = useState<SecretItemKind>("GENERIC");
  const [fields, setFields] = useState<TypedSecretFieldValues>({});

  const preparingKey = membershipState === "loading";
  const complete = isTypedSecretComplete(kind, fields);

  const setField = (key: string, v: string) => {
    setFields((f) => ({ ...f, [key]: v }));
    if (keyError) dispatchForm({ type: "setKeyError", keyError: false });
  };
  // Switching kind clears the typed fields so a value from a previous kind never bleeds across.
  const changeKind = (k: SecretItemKind) => {
    setKind(k);
    setFields({});
  };

  function reset() {
    dispatchForm({ type: "reset" });
    setKind("GENERIC");
    setFields({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || preparingKey || !label.trim() || !handle.trim() || !complete) return;
    const dek = ensureDek();
    if (!dek) {
      // Genuinely can't unwrap — keep the typed value, surface an inline recoverable error, do NOT toast
      // a dead-end. The user can lock + unlock and retry without losing their entry.
      dispatchForm({ type: "setKeyError", keyError: true });
      return;
    }
    dispatchForm({ type: "setKeyError", keyError: false });
    dispatchForm({ type: "setBusy", busy: true });
    try {
      // ADR-0075: encode the typed payload to a plaintext string, then seal it in the browser — never
      // send the plaintext. GENERIC encodes to the plain value (back-compat); `kind` is server-visible.
      const plaintext = encodeSecretPayload(buildTypedSecret(kind, fields));
      const envelope = sealItem(dek, plaintext);
      await createItem.mutateAsync({
        vaultId,
        data: {
          label: label.trim(),
          handle: handle.trim(),
          kind,
          ...envelope,
        },
      });
      toast.success(t("items.created", { label: label.trim() }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("items.createError"));
    } finally {
      // Drop the entered typed fields from state as soon as the mutation resolves,
      // regardless of success or failure — plaintext never lingers.
      setFields({});
      dispatchForm({ type: "setBusy", busy: false });
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
              onChange={(e) => dispatchForm({ type: "setLabel", value: e.target.value })}
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
                dispatchForm({
                  type: "setHandle",
                  value: e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
                })
              }
              disabled={busy}
              maxLength={80}
              placeholder={t("items.handlePlaceholder")}
              className="font-mono"
            />
            <FieldDescription>{t("items.handleHint")}</FieldDescription>
          </Field>

          {/* ADR-0075: kind selector + the typed value fields for the chosen kind. */}
          <TypedSecretFields
            kind={kind}
            onKindChange={changeKind}
            fields={fields}
            onFieldChange={setField}
            disabled={busy}
            idPrefix="add-item"
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
              disabled={busy || preparingKey || !label.trim() || !handle.trim() || !complete}
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
  // Seeded from `item` on first mount; the render-time sync below re-seeds on item change. The object
  // recomputed on later renders is discarded by React — same lifecycle as the original useState seeds.
  const [form, dispatchForm] = useReducer(editItemFormReducer, {
    label: item.label,
    handle: item.handle,
    busy: false,
    keyError: false,
  });
  const { label, handle, busy, keyError } = form;
  // Zero-knowledge: the typed plaintext fields live in their OWN dedicated state (ADR-0075), never folded
  // into the form reducer. The kind selector defaults to the item's current kind; to CHANGE the value (or
  // re-type the secret) the user fills the typed fields. Cleared on close / item-change / submit.
  const [kind, setKind] = useState<SecretItemKind>(item.kind);
  const [fields, setFields] = useState<TypedSecretFieldValues>({});
  // Sync fields when item identity changes (re-open for different item) — derived during render. The
  // tracker setter (setLastItemId) under the `item.id !== lastItemId` guard keeps this the recognized,
  // loop-safe set-state-in-render pattern; the reducer/kind/fields resets ride along with it.
  const [lastItemId, setLastItemId] = useState(item.id);
  if (item.id !== lastItemId) {
    setLastItemId(item.id);
    dispatchForm({ type: "syncItem", item });
    setKind(item.kind);
    setFields({});
  }

  const preparingKey = membershipState === "loading";
  // A new value is being supplied (re-encrypt) when the typed required field is filled.
  const hasNewValue = isTypedSecretComplete(kind, fields);
  // Re-typing the kind WITHOUT supplying a value would leave `kind` and the ciphertext inconsistent, so
  // we require the value when the kind changes. Only the value path needs the DEK.
  const retypedWithoutValue = kind !== item.kind && !hasNewValue;
  const needsKey = hasNewValue;

  const setField = (key: string, v: string) => {
    setFields((f) => ({ ...f, [key]: v }));
    if (keyError) dispatchForm({ type: "setKeyError", keyError: false });
  };
  const changeKind = (k: SecretItemKind) => {
    setKind(k);
    setFields({});
  };

  function handleOpenChange(next: boolean) {
    if (!next) {
      setFields({});
      setKind(item.kind);
      dispatchForm({ type: "setKeyError", keyError: false });
    }
    onOpenChange(next);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || (needsKey && preparingKey) || retypedWithoutValue) return;
    // Build partial update — envelope (+ kind) only if a new value was entered.
    type PatchData = {
      label?: string;
      handle?: string;
      ciphertext?: string;
      iv?: string;
      authTag?: string;
      keyVersion?: number;
      kind?: SecretItemKind;
    };
    const patch: PatchData = {};
    if (label.trim() && label.trim() !== item.label) patch.label = label.trim();
    if (handle.trim() && handle.trim() !== item.handle) patch.handle = handle.trim();

    if (needsKey) {
      const dek = ensureDek();
      if (!dek) {
        // Genuinely can't unwrap — surface an inline recoverable error and PRESERVE the typed value.
        // The user can lock + unlock and retry; we never drop their entry on this path.
        dispatchForm({ type: "setKeyError", keyError: true });
        return;
      }
      // ADR-0075: encode the typed payload, seal it, and pair `kind` with the fresh ciphertext so the
      // server-visible type and the encrypted shape never disagree.
      const envelope = sealItem(dek, encodeSecretPayload(buildTypedSecret(kind, fields)));
      Object.assign(patch, envelope);
      patch.kind = kind;
    }

    if (Object.keys(patch).length === 0) {
      handleOpenChange(false);
      return;
    }

    dispatchForm({ type: "setKeyError", keyError: false });
    dispatchForm({ type: "setBusy", busy: true });
    try {
      await updateItem.mutateAsync({ vaultId, itemId: item.id, data: patch });
      toast.success(t("items.updated", { label: label.trim() || item.label }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("items.updateError"));
    } finally {
      setFields({});
      dispatchForm({ type: "setBusy", busy: false });
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
              onChange={(e) => dispatchForm({ type: "setLabel", value: e.target.value })}
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
                dispatchForm({
                  type: "setHandle",
                  value: e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
                })
              }
              disabled={busy}
              maxLength={80}
              className="font-mono"
            />
          </Field>
          {/* ADR-0075: change the type and/or replace the value. Leave the typed fields blank to keep the
              current value (label/handle-only edits need no key). */}
          <TypedSecretFields
            kind={kind}
            onKindChange={changeKind}
            fields={fields}
            onFieldChange={setField}
            disabled={busy}
            idPrefix="edit-item"
          />
          {keyError ? (
            <FieldDescription className="text-destructive">
              {t("items.dekUnavailableInline")}
            </FieldDescription>
          ) : retypedWithoutValue ? (
            <FieldDescription className="text-destructive">
              {t("items.retypeNeedsValue")}
            </FieldDescription>
          ) : needsKey && preparingKey ? (
            <FieldDescription>{t("items.preparingKey")}</FieldDescription>
          ) : (
            <FieldDescription>{t("items.newValueHint")}</FieldDescription>
          )}

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
                busy || (needsKey && preparingKey) || retypedWithoutValue || !label.trim()
              }
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
// ExportDialog — #612: client-side decrypt → .env download + metadata-only audit
// ---------------------------------------------------------------------------

/** Trigger a browser download of `text` as a `.env` file named after the vault. Browser-only, no network. */
function downloadEnvFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has surely started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Slugify a vault name into a safe `.env` filename stem (ASCII, dashes). Non-secret metadata only. */
function vaultFilename(vaultName: string): string {
  const stem =
    vaultName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "vault";
  return `${stem}.env`;
}

/**
 * ExportDialog (#612). The browser DECRYPTS every readable item with the in-memory DEK, builds a `.env`
 * text, and triggers a download — ENTIRELY CLIENT-SIDE (INV-10). Only AFTER the file is built do we call
 * the metadata-only audit endpoint (`useRecordExport`) with `{ itemCount }`. NO plaintext, ciphertext,
 * or DEK is ever sent — the audit body is a strictObject the server can only read as a count.
 *
 * Gated behind a CONFIRM that names the risk in plain language: this writes secrets in PLAINTEXT to disk.
 */
function ExportDialog({
  open,
  onOpenChange,
  vaultId,
  vaultName,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
  vaultName: string;
  items: SecretItem[];
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { ensureDek } = useVaultDek(vaultId);
  const recordExport = useRecordExport();
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    if (busy) return;
    const dek = ensureDek();
    if (!dek) {
      // The DEK isn't available (session settling / membership) — surface a friendly error, never a crash.
      toast.error(t("export.dekUnavailable"));
      return;
    }
    setBusy(true);
    try {
      // Decrypt every item in the browser. A single tampered/wrong-DEK item must not abort the whole
      // export — collect what we can and report any that failed.
      const entries: EnvEntry[] = [];
      let failed = 0;
      for (const item of items) {
        try {
          entries.push({
            key: item.handle,
            value: openItem(dek, {
              ciphertext: item.ciphertext,
              iv: item.iv,
              authTag: item.authTag,
              keyVersion: item.keyVersion,
            }),
          });
        } catch {
          failed += 1;
        }
      }

      if (entries.length === 0) {
        toast.error(t("export.error"));
        return;
      }

      downloadEnvFile(vaultFilename(vaultName), serializeEnv(entries));

      // INV-10: metadata-only audit. The body carries ONLY the non-secret count — no value, no DEK.
      try {
        await recordExport.mutateAsync({
          vaultId,
          audit: { itemCount: entries.length },
        });
      } catch {
        // The file already downloaded; a failed audit write shouldn't read as a failed export. Log-free.
      }

      toast.success(
        failed > 0
          ? t("export.successPartial", { count: entries.length, failed })
          : t("export.success", { count: entries.length }),
      );
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
          <DialogDescription>
            {t("export.description", { count: items.length })}
          </DialogDescription>
        </DialogHeader>

        <Callout tone="warning" className="text-xs">
          {t("export.plaintextWarning")}
        </Callout>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={handleExport} disabled={busy}>
            {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <ArrowDownTrayIcon className="size-4" />}
            {busy ? t("export.exporting") : t("export.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ImportDialog — #613: parse .env → preview (new/skipped) → encrypt + create each NEW item
// ---------------------------------------------------------------------------

/**
 * ImportDialog (#613). Parse a pasted/uploaded `.env` blob CLIENT-SIDE, preview which keys are NEW vs
 * already-present (skip-existing collision policy — never overwrite), then for each NEW entry seal the
 * value with the in-memory DEK (`sealItem`) and create it through the EXISTING create-item endpoint.
 *
 * INV-10: parsing + encryption happen in the browser; only the ciphertext envelope (+ non-secret
 * label/handle) is ever sent — identical to the single-secret create path. No new backend.
 */
function ImportDialog({
  open,
  onOpenChange,
  vaultId,
  vaultName,
  existingItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
  vaultName: string;
  existingItems: SecretItem[];
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { ensureDek } = useVaultDek(vaultId);
  const createItem = useCreateItem();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const existingHandles = useMemo(
    () => existingItems.map((it) => it.handle),
    [existingItems],
  );

  // Live preview from the pasted text — pure parse, no crypto, no network.
  const parsed = useMemo(() => parseEnv(text), [text]);
  const { toCreate, skipped } = useMemo(
    () => splitNewVsExisting(parsed.entries, existingHandles),
    [parsed.entries, existingHandles],
  );

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) setText("");
    onOpenChange(next);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    e.target.value = ""; // allow re-selecting the same file
  }

  async function handleImport() {
    if (busy || toCreate.length === 0) return;
    const dek = ensureDek();
    if (!dek) {
      toast.error(t("import.dekUnavailable"));
      return;
    }
    setBusy(true);
    let created = 0;
    let failed = 0;
    try {
      for (const entry of toCreate) {
        try {
          // Seal in the browser — the plaintext value never leaves the device.
          const envelope = sealItem(dek, entry.value);
          await createItem.mutateAsync({
            vaultId,
            data: {
              // handles are lowercased + restricted like the single-add form.
              label: entry.key,
              handle: entry.key.toLowerCase().replace(/[^a-z0-9_.-]/g, ""),
              ...envelope,
            },
          });
          created += 1;
        } catch {
          failed += 1;
        }
      }
      if (created > 0) {
        toast.success(
          failed > 0
            ? t("import.successPartial", { created, failed })
            : t("import.success", { created }),
        );
      } else {
        toast.error(t("import.error"));
      }
      if (failed === 0) handleOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  const hasInput = text.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>
            {t("import.description", { vault: vaultName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="import-text">{t("import.pasteLabel")}</FieldLabel>
            <textarea
              id="import-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
              rows={6}
              spellCheck={false}
              placeholder={t("import.pastePlaceholder")}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <FieldDescription>
              {/* Upload alternative — the file is read in the browser, never sent. */}
              <label className="cursor-pointer text-primary underline-offset-2 hover:underline">
                {t("import.uploadLabel")}
                <input
                  type="file"
                  accept=".env,text/plain"
                  onChange={handleFile}
                  disabled={busy}
                  className="sr-only"
                />
              </label>
            </FieldDescription>
          </Field>

          {/* Preview — appears as soon as there's parseable input. */}
          {hasInput ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
              <p className="font-medium">
                {t("import.previewSummary", {
                  create: toCreate.length,
                  skip: skipped.length,
                })}
              </p>
              {toCreate.length > 0 ? (
                <p className="text-muted-foreground">
                  {t("import.previewNew")}{" "}
                  <span className="font-mono">
                    {toCreate.map((e) => e.key).join(", ")}
                  </span>
                </p>
              ) : null}
              {skipped.length > 0 ? (
                <p className="text-muted-foreground">
                  {t("import.previewSkipped")}{" "}
                  <span className="font-mono">
                    {skipped.map((e) => e.key).join(", ")}
                  </span>
                </p>
              ) : null}
              {parsed.malformed.length > 0 ? (
                <p className="text-destructive">
                  {t("import.previewMalformed", { count: parsed.malformed.length })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

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
            type="button"
            onClick={handleImport}
            disabled={busy || toCreate.length === 0}
          >
            {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : <ArrowUpTrayIcon className="size-4" />}
            {busy
              ? t("import.importing")
              : t("import.confirm", { count: toCreate.length })}
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
// AddServiceAccountDialog — grant/revoke a SERVICE ACCOUNT as a crypto member (ADR-0080)
// ---------------------------------------------------------------------------

/**
 * AddServiceAccountDialog — the OUTER shell (mirrors {@link AddMemberDialog}). The body (and its
 * service-account + membership + public-key queries) mounts ONLY while `open`, so nothing fetches until an
 * admin opens the dialog.
 *
 * ponytail: the backend exposes POST (grant) + DELETE (revoke) for SA memberships but NO endpoint to LIST
 * a vault's current service-account members (`loadMembers` returns human members only). So this dialog
 * grants/revokes BY SELECTION and relies on the server for truth (409 = already a member, 404 = not a
 * member) rather than rendering an inline SA-member list. Ceiling: an inline "current machine members"
 * list is a follow-up once the API exposes a read.
 */
function AddServiceAccountDialog({
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
          <DialogTitle>{t("serviceAccountMembers.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("serviceAccountMembers.addDescription")}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AddServiceAccountDialogBody
            vaultId={vaultId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The grant/revoke form + its data hooks. Mounted only while the dialog is open. */
function AddServiceAccountDialogBody({
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
  const addServiceAccount = useAddServiceAccountMember();
  const removeServiceAccount = useRemoveServiceAccountMember();

  // Live service accounts; only those holding `secret:fetch` can crypto-read a vault (ADR-0080), so we
  // offer just those — an SA without the Fetch permission has no keypair to wrap the DEK to.
  const {
    data: allAccounts,
    isLoading: accountsLoading,
    isError: accountsLoadError,
  } = useServiceAccounts();
  const fetchAccounts = useMemo<ServiceAccount[]>(
    () =>
      (allAccounts ?? []).filter((a) => a.permissions.includes("secret:fetch")),
    [allAccounts],
  );

  const [targetSaId, setTargetSaId] = useState("");
  // A single in-flight action at a time — which one is running (for the per-button spinner).
  const [busy, setBusy] = useState<null | "grant" | "revoke">(null);

  // Fetch the target SA's public key only when one is selected. A 404 means the SA has no keypair (a
  // pre-#883 SA created before keypairs were auto-generated) — surfaced distinctly and it blocks the grant.
  // The fix: rotate the SA's token (Settings → Service accounts), which regenerates its keypair (#883).
  const {
    data: saPublicKey,
    isLoading: publicKeyLoading,
    isError: publicKeyError,
    error: publicKeyErrorObj,
  } = useServiceAccountPublicKey(targetSaId || undefined);

  const noEligible =
    !accountsLoading && !accountsLoadError && fetchAccounts.length === 0;
  const targetNoKeypair =
    !!targetSaId &&
    !publicKeyLoading &&
    publicKeyError &&
    publicKeyErrorObj instanceof ApiError &&
    publicKeyErrorObj.status === 404;

  const targetName =
    fetchAccounts.find((a) => a.id === targetSaId)?.name ?? targetSaId;

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !targetSaId || !saPublicKey) return;

    const privateKey = getPrivateKey();
    const mship = myMembership ?? membership;
    if (!privateKey || !mship) {
      toast.error(t("members.grantDekUnavailable"));
      return;
    }

    setBusy("grant");
    try {
      // "No grant-what-you-can't-read": wrapDekForMember FIRST unwraps the DEK from our own membership,
      // THEN wraps it to the SA's public key. Only the wrapped blob crosses the wire (INV-10).
      const targetPubKeyBytes = base64ToBytes(saPublicKey.publicKey);
      const wrappedDek = wrapDekForMember(privateKey, mship, targetPubKeyBytes);
      await addServiceAccount.mutateAsync({
        vaultId,
        data: { serviceAccountId: targetSaId, ...wrappedDek },
      });
      toast.success(t("serviceAccountMembers.granted", { name: targetName }));
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Desired end-state already holds — the SA is a member. Inform, don't alarm.
        toast.info(t("serviceAccountMembers.alreadyMember", { name: targetName }));
      } else {
        notifyError(err, t("serviceAccountMembers.grantError"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke() {
    if (busy || !targetSaId) return;
    setBusy("revoke");
    try {
      await removeServiceAccount.mutateAsync({ vaultId, saId: targetSaId });
      toast.success(t("serviceAccountMembers.revoked", { name: targetName }));
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Desired end-state already holds — the SA is not a member.
        toast.info(t("serviceAccountMembers.notMember", { name: targetName }));
      } else {
        notifyError(err, t("serviceAccountMembers.revokeError"));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={handleGrant} className="space-y-4">
      <Field>
        <FieldLabel htmlFor="grant-sa">
          {t("serviceAccountMembers.accountLabel")}
        </FieldLabel>
        {accountsLoading ? (
          <div className="h-9 animate-pulse rounded-md bg-muted" />
        ) : accountsLoadError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {t("serviceAccountMembers.loadError")}
          </p>
        ) : noEligible ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {t("serviceAccountMembers.noEligible")}
          </p>
        ) : (
          <select
            id="grant-sa"
            value={targetSaId}
            onChange={(e) => setTargetSaId(e.target.value)}
            disabled={busy !== null}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">{t("serviceAccountMembers.selectAccount")}</option>
            {fetchAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {targetNoKeypair ? (
          <FieldDescription className="text-destructive">
            {t("serviceAccountMembers.noKeypair")}{" "}
            <Link
              href="/settings/service-accounts"
              className="font-medium underline underline-offset-2"
            >
              {t("serviceAccountMembers.noKeypairAction")}
            </Link>
          </FieldDescription>
        ) : (
          <FieldDescription>
            {t("serviceAccountMembers.grantHint")}
          </FieldDescription>
        )}
      </Field>

      {!accountsLoading && !accountsLoadError && !noEligible ? (
        <DialogFooter className="sm:justify-between">
          {/* Revoke is available by selection too (no membership-list endpoint — see ponytail note). A 404
              is treated as an informational no-op, so this is safe to offer for any selected account. */}
          <Button
            type="button"
            variant="ghost"
            onClick={handleRevoke}
            disabled={busy !== null || !targetSaId}
            className="text-destructive hover:text-destructive"
          >
            {busy === "revoke" ? (
              <ArrowPathIcon className="size-4 animate-spin" />
            ) : null}
            {t("serviceAccountMembers.revokeAction")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy !== null}
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                busy !== null ||
                !targetSaId ||
                publicKeyLoading ||
                !saPublicKey
              }
            >
              {busy === "grant" || publicKeyLoading ? (
                <ArrowPathIcon className="size-4 animate-spin" />
              ) : null}
              {busy === "grant"
                ? t("serviceAccountMembers.granting")
                : t("serviceAccountMembers.grantSubmit")}
            </Button>
          </div>
        </DialogFooter>
      ) : (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy !== null}
          >
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
