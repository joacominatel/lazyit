"use client";

import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useClientOnlyConfigStatus } from "@/lib/api/hooks/use-config-status";
import { ProvisionLocalAccountButton } from "./provision-local-account-button";

// Under OIDC the IdP owns accounts (ADR-0102 §5); the person links on first verified-email sign-in.
export function ProvisionAccountButton({ user }: { user: User }) {
  const t = useTranslations("users");
  const { data: status } = useClientOnlyConfigStatus();

  if (!status) return null;

  if (status.canProvisionLocalAccounts === true) {
    return <ProvisionLocalAccountButton user={user} />;
  }

  return (
    <p className="max-w-prose text-xs text-muted-foreground" role="note">
      {t("directory.provision.unsupported")}
    </p>
  );
}
