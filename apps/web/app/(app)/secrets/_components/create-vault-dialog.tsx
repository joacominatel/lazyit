"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
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
import { createVaultMaterial } from "@/lib/secret-manager/crypto";
import { getMyMembership } from "@/lib/secret-manager/endpoints/members";
import { useMyKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import { useCreateVault } from "@/lib/secret-manager/hooks/use-vaults";
import { membershipKeys } from "@/lib/secret-manager/query-keys";
import { base64ToBytes } from "./crypto-bytes";
import { useSecretDek } from "./secret-session";

/**
 * CreateVaultDialog — mint a new vault (ADR-0061 §2/§3). Generates the DEK + the creator's self-wrap
 * CLIENT-SIDE (`createVaultMaterial(myPublicKey)`), posts only `{ name, membership: selfWrap }`, and
 * caches the freshly-generated DEK in the in-memory session so the creator can immediately add items
 * without an extra unwrap. The raw DEK never leaves the browser.
 *
 * SECW-05: the DEK is cached ONLY AFTER the creator's membership round-trip is CONFIRMED. The vault POST
 * persists the vault row + the self-wrap membership; if that write were partial (vault created, membership
 * missing) the cached DEK would be orphaned — the creator would hold a key they can never re-derive. So
 * after `createVault` resolves we re-fetch the caller's own membership (`getMyMembership`, the wrapped-DEK
 * row) for the new vault and cache the DEK ONLY when that confirms. The fetch also primes the
 * `membershipKeys.me` cache that `useMyMembership` / `ensureDek` read later, so the read-chain is coherent.
 * (The fetched blob is wrapped ciphertext the server already holds — caching it is INV-10-safe; the
 * UNWRAPPED DEK is still only ever held in the in-memory session.)
 *
 * Gated by the caller's holding `secret:manage` (enforced by the parent + the API).
 */
export function CreateVaultDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("secrets");
  const tc = useTranslations("common");
  const { cacheDek } = useSecretDek();
  const queryClient = useQueryClient();
  const { data: keypair } = useMyKeypair();
  const createVault = useCreateVault();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!next) setName("");
    onOpenChange(next);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || !keypair) return;
    setBusy(true);
    try {
      // Generate the DEK + self-wrap in the browser from the caller's public key.
      const myPublicKey = base64ToBytes(keypair.publicKey);
      const { dek, selfWrap } = createVaultMaterial(myPublicKey);
      const vault = await createVault.mutateAsync({ name: name.trim(), membership: selfWrap });

      // SECW-05: confirm the membership write round-tripped BEFORE caching the DEK. A partial write (vault
      // created but no membership row) would otherwise orphan the cached DEK. `fetchQuery` proves the row
      // exists AND primes `membershipKeys.me(vault.id)` for the read-chain. We do NOT short-circuit on the
      // just-created cache — `getMyMembership` must actually resolve from the server.
      try {
        await queryClient.fetchQuery({
          queryKey: membershipKeys.me(vault.id),
          queryFn: () => getMyMembership(vault.id),
          staleTime: 0,
        });
      } catch (confirmErr) {
        // The vault exists but its membership could not be confirmed — do NOT cache the (now orphaned) DEK.
        // The vault row is real, so the creator can reopen it and unlock via the membership path once it
        // settles; caching here would silently mask a broken vault.
        notifyError(confirmErr, t("vaults.createMembershipUnconfirmed"));
        return;
      }

      // Confirmed — cache the DEK so the creator can add the first item without re-unwrapping.
      cacheDek(vault.id, dek);
      toast.success(t("vaults.created", { name: vault.name }));
      handleOpenChange(false);
    } catch (err) {
      notifyError(err, t("vaults.createError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("vaults.createTitle")}</DialogTitle>
          <DialogDescription>{t("vaults.createDescription")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="vault-name">{t("vaults.nameLabel")}</FieldLabel>
            <Input
              id="vault-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              maxLength={120}
              placeholder={t("vaults.namePlaceholder")}
              autoFocus
            />
            <FieldDescription>{t("vaults.nameHint")}</FieldDescription>
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
            <Button type="submit" disabled={busy || !name.trim() || !keypair}>
              {busy ? <ArrowPathIcon className="size-4 animate-spin" /> : null}
              {busy ? t("vaults.creating") : t("vaults.createSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
