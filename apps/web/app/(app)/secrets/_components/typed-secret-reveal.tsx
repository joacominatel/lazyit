"use client";

import { CheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { copyTextWithAutoClear } from "@/lib/secret-manager/clipboard";
import { generateTotp, type TotpAlgorithm } from "@/lib/secret-manager/totp";
import { parseSecretPayload } from "@/lib/secret-manager/typed-secret";
import type { SecretItemKind } from "@lazyit/shared";

/**
 * Typed-secret reveal renderer (ADR-0075). Once the parent has DECRYPTED the value (browser-only, the
 * existing `openItem` chain), it parses the plaintext by `kind` and renders the right shape: SSH key as
 * copyable monospace blocks, a CERTIFICATE as cert/key/chain blocks, and a TOTP as a LIVE 6-digit code
 * with a countdown that refreshes each step. A `kind` whose plaintext does not match (legacy GENERIC
 * value under a re-typed kind) degrades to a raw block via {@link parseSecretPayload}.
 *
 * ZERO-KNOWLEDGE: this component only ever holds the plaintext the parent already revealed; it adds NO
 * persistence. The parent's `REVEAL_TIMEOUT_MS` auto-mask + session-lock UNMOUNT this subtree, which
 * cancels every pending clipboard auto-clear via the unmount cleanup below. Copies reuse the shared
 * best-effort clipboard auto-clear, exactly like the single-value path.
 */
export function TypedSecretReveal({
  kind,
  plaintext,
}: {
  kind: SecretItemKind;
  plaintext: string;
}) {
  const parsed = parseSecretPayload(kind, plaintext);

  switch (parsed.kind) {
    case "GENERIC":
      return <SecretField mono value={parsed.value} />;
    case "SSH_KEY": {
      const t = parsed.value;
      return (
        <div className="mt-1 w-full space-y-2">
          <LabeledField labelKey="sshPrivateKey" value={t.privateKey} block />
          {t.publicKey ? (
            <LabeledField labelKey="sshPublicKey" value={t.publicKey} block />
          ) : null}
          {t.passphrase ? (
            <LabeledField labelKey="sshPassphrase" value={t.passphrase} />
          ) : null}
        </div>
      );
    }
    case "CERTIFICATE": {
      const t = parsed.value;
      return (
        <div className="mt-1 w-full space-y-2">
          <LabeledField labelKey="certificate" value={t.certificate} block />
          {t.privateKey ? (
            <LabeledField labelKey="certPrivateKey" value={t.privateKey} block />
          ) : null}
          {t.chain ? (
            <LabeledField labelKey="certChain" value={t.chain} block />
          ) : null}
        </div>
      );
    }
    case "TOTP":
      return <TotpReveal payload={parsed.value} />;
  }
}

/** A copy button that reuses the shared best-effort clipboard auto-clear (#607); self-cleaning. */
function CopyButton({ value }: { value: string }) {
  const t = useTranslations("secrets");
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      cancelRef.current?.();
      clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  async function handleCopy() {
    cancelRef.current?.();
    const { ok, cancel } = await copyTextWithAutoClear(value);
    if (!ok) return;
    cancelRef.current = cancel;
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
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
  );
}

/** A bare value + copy (used for GENERIC and the TOTP seed). `block` wraps long multi-line values. */
function SecretField({
  value,
  mono,
  block,
}: {
  value: string;
  mono?: boolean;
  block?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      {block ? (
        <pre className="max-h-40 min-w-0 flex-1 overflow-auto rounded bg-muted/60 px-2 py-1 text-xs font-mono whitespace-pre-wrap break-all select-all">
          {value}
        </pre>
      ) : (
        <code
          className={`max-w-xs truncate rounded bg-muted/60 px-2 py-0.5 text-xs select-all ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
      )}
      <CopyButton value={value} />
    </div>
  );
}

/** A labeled typed field (label above, monospace value + copy below). */
function LabeledField({
  labelKey,
  value,
  block,
}: {
  labelKey: string;
  value: string;
  block?: boolean;
}) {
  const t = useTranslations("secrets");
  return (
    <div className="space-y-0.5">
      <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
        {t(`typed.${labelKey}`)}
      </p>
      <SecretField value={value} mono block={block} />
    </div>
  );
}

/** The live TOTP renderer — a refreshing code + countdown + copy, plus the (sensitive) seed under copy. */
function TotpReveal({
  payload,
}: {
  payload: {
    secret: string;
    issuer?: string;
    account?: string;
    digits?: number;
    period?: number;
    algorithm?: TotpAlgorithm;
  };
}) {
  const t = useTranslations("secrets");
  const [state, setState] = useState<{
    code: string;
    secondsRemaining: number;
  } | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let active = true;
    async function tick() {
      try {
        const result = await generateTotp({
          secret: payload.secret,
          digits: payload.digits,
          period: payload.period,
          algorithm: payload.algorithm,
        });
        if (active) {
          setState(result);
          setInvalid(false);
        }
      } catch {
        if (active) setInvalid(true);
      }
    }
    void tick();
    // Re-derive every second so the code rolls over at the step boundary and the countdown ticks.
    const id = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [payload.secret, payload.digits, payload.period, payload.algorithm]);

  if (invalid) {
    return <span className="text-xs text-destructive">{t("typed.totpInvalid")}</span>;
  }

  const period = payload.period ?? 30;
  const pct = state ? (state.secondsRemaining / period) * 100 : 0;

  return (
    <div className="mt-1 w-full space-y-2">
      <div className="flex items-center gap-3">
        <code className="rounded bg-muted/60 px-2 py-1 text-lg font-mono tracking-[0.3em] tabular-nums select-all">
          {state ? state.code : "------"}
        </code>
        {state ? <CopyButton value={state.code} /> : null}
        {state ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="h-1.5 w-10 overflow-hidden rounded-full bg-muted"
              aria-hidden
            >
              <span
                className="block h-full bg-pillar-knowledge transition-[width] duration-1000 ease-linear"
                style={{ width: `${pct}%` }}
              />
            </span>
            {t("typed.totpExpiresIn", { seconds: state.secondsRemaining })}
          </span>
        ) : null}
      </div>
      {payload.issuer || payload.account ? (
        <p className="text-xs text-muted-foreground">
          {[payload.issuer, payload.account].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <LabeledField labelKey="totpSecret" value={payload.secret} />
    </div>
  );
}
