"use client";

import type { ServiceAccount } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TestItPanel } from "./test-it-panel";

/**
 * The per-row "How to test" surface (issue #197, placement b). Mounts the permission-aware
 * {@link TestItPanel} for an existing account at any time — derived from `account.permissions`, not the
 * (never-recoverable) secret — so an operator can re-check how to exercise a token's scope long after
 * the one-time reveal closed. The token is always a `<…>` placeholder; this screen only ever holds
 * `tokenPrefix`, never the secret.
 */
export function TestItDialog({
  account,
  open,
  onOpenChange,
}: {
  account: ServiceAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("serviceAccounts.testIt.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("serviceAccounts.testIt.dialogDescription", { name: account.name })}
          </DialogDescription>
        </DialogHeader>
        <TestItPanel permissions={account.permissions} />
      </DialogContent>
    </Dialog>
  );
}
