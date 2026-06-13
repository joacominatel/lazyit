"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
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
import { useMyKeypair } from "@/lib/secret-manager/hooks/use-keypair";
import { useCreateVault } from "@/lib/secret-manager/hooks/use-vaults";
import { base64ToBytes } from "./crypto-bytes";
import { useSecretSession } from "./secret-session";

/**
 * CreateVaultDialog — mint a new vault (ADR-0061 §2/§3). Generates the DEK + the creator's self-wrap
 * CLIENT-SIDE (`createVaultMaterial(myPublicKey)`), posts only `{ name, membership: selfWrap }`, and
 * caches the freshly-generated DEK in the in-memory session so the creator can immediately add items
 * without an extra unwrap. The raw DEK never leaves the browser.
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
  const { cacheDek } = useSecretSession();
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
      // Cache the DEK so the creator can add the first item without re-unwrapping.
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
