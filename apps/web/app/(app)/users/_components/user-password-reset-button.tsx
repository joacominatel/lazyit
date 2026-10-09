"use client";

import { KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePasswordResetCapabilities } from "@/lib/api/hooks/use-users";
import { useCan } from "@/lib/hooks/use-permissions";
import { LocalPasswordResetDialog } from "./local-password-reset-dialog";

interface UserPasswordResetButtonProps {
  /** The user whose password reset is being triggered. */
  user: User;
}

// Local mode only: under OIDC the IdP owns credentials, so there is nothing to offer (ADR-0102 §5).
export function UserPasswordResetButton({ user }: UserPasswordResetButtonProps) {
  const t = useTranslations("users.passwordReset");
  const canManage = useCan("user:manage");
  const capabilities = usePasswordResetCapabilities({ enabled: canManage });
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!canManage || capabilities.data?.canResetLocally !== true) return null;

  const disabledReason = !user.isActive
    ? t("disabledInactive")
    : user.directoryOnly
      ? t("disabledDirectoryOnly")
      : null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={disabledReason != null}
        title={disabledReason ?? undefined}
        className="border-warning/40 hover:border-warning/70 hover:bg-warning/5"
      >
        {/* Amber key cues a sensitive (but non-destructive) security action — distinct from the
            red Offboard, and the label stays on --foreground so contrast holds. */}
        <KeyIcon className="text-warning" />
        {t("button")}
      </Button>

      <LocalPasswordResetDialog
        user={user}
        capabilities={capabilities.data}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      />
    </>
  );
}
