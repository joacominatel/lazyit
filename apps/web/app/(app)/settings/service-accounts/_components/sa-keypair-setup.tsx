"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Callout } from "@/components/callout";
import { ApiError } from "@/lib/api/client";
import { bootstrapServiceAccountKeypair } from "@/lib/secret-manager/crypto";
import { useCreateServiceAccountKeypair } from "@/lib/secret-manager/hooks/use-service-account-members";

type SetupState = "working" | "done" | "forbidden" | "error";

/**
 * SaKeypairSetup (ADR-0080, #883) — generates/replaces a service account's zero-knowledge keypair while a
 * one-time token is STILL in memory. Rendered in the token-reveal of BOTH flows:
 *   - CREATE — for EVERY new SA (not just `secret:fetch` ones); an unused keypair is negligible and it
 *     removes the "no encryption key" footgun if the SA is later granted `secret:fetch`.
 *   - ROTATION — the new token re-wraps a fresh keypair, which REPLACES the stored one server-side (the
 *     retrofit path for a pre-#883 keyless SA). The old keypair was wrapped under the now-dead token, so
 *     regenerating is mandatory for the SA to keep working — and it drops the SA's vault grants (re-grant).
 *
 * INV-10: the token is used ONLY to derive the key that wraps the fresh private key, entirely in the
 * browser (`bootstrapServiceAccountKeypair`). What we POST is the public key + the wrapped blob — never the
 * token, the private key, or the derived key. The token is not sent to this endpoint.
 *
 * Non-fatal by design: the SA already exists. If the keypair setup fails — most commonly because the
 * operator holds `settings:manage` but not `secret:manage` (a 403) — we say so plainly; the account is
 * fine, it just has no encryption key and can get one by rotating its token with the right permission.
 */
export function SaKeypairSetup({
  saId,
  token,
}: {
  saId: string;
  token: string;
}) {
  const t = useTranslations("settings");
  const createKeypair = useCreateServiceAccountKeypair();
  const [state, setState] = useState<SetupState>("working");
  // Run EXACTLY once, while the token is in memory. A ref guards against React 19 StrictMode's
  // double-invoke and any re-render; the POST completes server-side even if the dialog closes mid-flight.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const wire = await bootstrapServiceAccountKeypair(token);
        await createKeypair.mutateAsync({ saId, data: wire });
        setState("done");
      } catch (err) {
        setState(
          err instanceof ApiError && err.status === 403 ? "forbidden" : "error",
        );
      }
    })();
    // No cleanup/cancel flag on purpose: the ref already guarantees a single POST, and a stale-closure
    // cancel would strand the state on "working" under React StrictMode's mount→unmount→mount in dev. A
    // late setState after a real close is a harmless no-op (React 18/19 no longer warns).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once while the token is in memory; startedRef guards re-entry, deps intentionally empty
  }, []);

  if (state === "working") {
    return (
      <Callout
        tone="info"
        icon={<ArrowPathIcon className="animate-spin" />}
        className="text-sm"
      >
        {t("serviceAccounts.keypairSetup.working")}
      </Callout>
    );
  }
  if (state === "done") {
    return (
      <Callout tone="success" icon={<CheckCircleIcon />} className="text-sm">
        {t("serviceAccounts.keypairSetup.done")}
      </Callout>
    );
  }
  return (
    <Callout
      tone="warning"
      icon={<ExclamationTriangleIcon />}
      className="text-sm"
    >
      {state === "forbidden"
        ? t("serviceAccounts.keypairSetup.forbidden")
        : t("serviceAccounts.keypairSetup.error")}
    </Callout>
  );
}
