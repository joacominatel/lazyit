"use client";

import { useTranslations } from "next-intl";
import type { SecretItemKind } from "@lazyit/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type TotpAlgorithm,
  type TypedSecret,
} from "@/lib/secret-manager/typed-secret";
import { SECRET_KINDS } from "./secret-kind";

/**
 * Typed-secret VALUE input (ADR-0075). Renders the kind selector + the fields for the chosen `kind`,
 * driven by a flat `Record<string,string>` of RAW field strings the parent owns. The PLAINTEXT typed
 * material lives in that parent state (its own useState, never folded into a reducer/query/storage), so
 * the zero-knowledge discipline of the existing forms is preserved — the parent clears it on submit/
 * close. This component is presentational; encoding to the wire string happens via {@link buildTypedSecret}
 * at submit time.
 *
 * GENERIC renders the single password input the form has always had (unchanged common path). The typed
 * kinds add their structured fields; required fields are marked, optionals are clearly optional.
 */

/** The TOTP algorithm choices offered in the selector. */
const TOTP_ALGORITHMS: TotpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

export type TypedSecretFieldValues = Record<string, string>;

/** Is the REQUIRED field for this kind filled? Gates form submission. */
export function isTypedSecretComplete(
  kind: SecretItemKind,
  fields: TypedSecretFieldValues,
): boolean {
  switch (kind) {
    case "GENERIC":
      return (fields.value ?? "").length > 0;
    case "SSH_KEY":
      return (fields.privateKey ?? "").trim().length > 0;
    case "TOTP":
      return (fields.secret ?? "").trim().length > 0;
    case "CERTIFICATE":
      return (fields.certificate ?? "").trim().length > 0;
  }
}

/** Coerce a raw numeric field to a number, or `undefined` when blank/invalid (so it is dropped). */
function num(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the {@link TypedSecret} the codec encodes, from the raw form fields. GENERIC keeps the plain
 * value; typed kinds assemble their object (numbers coerced). Optional empties are dropped by the codec.
 */
export function buildTypedSecret(
  kind: SecretItemKind,
  fields: TypedSecretFieldValues,
): TypedSecret {
  switch (kind) {
    case "GENERIC":
      return { kind, value: fields.value ?? "" };
    case "SSH_KEY":
      return {
        kind,
        value: {
          privateKey: fields.privateKey ?? "",
          publicKey: fields.publicKey,
          passphrase: fields.passphrase,
        },
      };
    case "TOTP":
      return {
        kind,
        value: {
          secret: (fields.secret ?? "").trim(),
          issuer: fields.issuer,
          account: fields.account,
          digits: num(fields.digits),
          period: num(fields.period),
          algorithm: (fields.algorithm as TotpAlgorithm) || undefined,
        },
      };
    case "CERTIFICATE":
      return {
        kind,
        value: {
          certificate: fields.certificate ?? "",
          privateKey: fields.privateKey,
          chain: fields.chain,
        },
      };
  }
}

interface TypedSecretFieldsProps {
  kind: SecretItemKind;
  onKindChange: (kind: SecretItemKind) => void;
  fields: TypedSecretFieldValues;
  onFieldChange: (key: string, value: string) => void;
  disabled?: boolean;
  /** Unique id prefix so add/edit dialogs don't collide on element ids. */
  idPrefix: string;
  /** Render the kind selector (hidden when re-typing is not offered). Default true. */
  showKindSelect?: boolean;
}

export function TypedSecretFields({
  kind,
  onKindChange,
  fields,
  onFieldChange,
  disabled,
  idPrefix,
  showKindSelect = true,
}: TypedSecretFieldsProps) {
  const t = useTranslations("secrets");

  return (
    <>
      {showKindSelect ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-kind`}>
            {t("items.kindField")}
          </FieldLabel>
          <Select
            value={kind}
            onValueChange={(v) => onKindChange(v as SecretItemKind)}
            disabled={disabled}
          >
            <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECRET_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kinds.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{t(`kindHints.${kind}`)}</FieldDescription>
        </Field>
      ) : null}

      {kind === "GENERIC" ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-value`}>
            {t("items.valueField")}
          </FieldLabel>
          <Input
            id={`${idPrefix}-value`}
            type="password"
            autoComplete="new-password"
            value={fields.value ?? ""}
            onChange={(e) => onFieldChange("value", e.target.value)}
            disabled={disabled}
            placeholder={t("items.valuePlaceholder")}
          />
        </Field>
      ) : null}

      {kind === "SSH_KEY" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-ssh-private`}>
              {t("typed.sshPrivateKey")}
            </FieldLabel>
            <Textarea
              id={`${idPrefix}-ssh-private`}
              value={fields.privateKey ?? ""}
              onChange={(e) => onFieldChange("privateKey", e.target.value)}
              disabled={disabled}
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={t("typed.sshPrivateKeyPlaceholder")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-ssh-public`}>
              {t("typed.sshPublicKey")}
            </FieldLabel>
            <Textarea
              id={`${idPrefix}-ssh-public`}
              value={fields.publicKey ?? ""}
              onChange={(e) => onFieldChange("publicKey", e.target.value)}
              disabled={disabled}
              rows={2}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-ssh-passphrase`}>
              {t("typed.sshPassphrase")}
            </FieldLabel>
            <Input
              id={`${idPrefix}-ssh-passphrase`}
              type="password"
              autoComplete="new-password"
              value={fields.passphrase ?? ""}
              onChange={(e) => onFieldChange("passphrase", e.target.value)}
              disabled={disabled}
            />
          </Field>
        </>
      ) : null}

      {kind === "TOTP" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-totp-secret`}>
              {t("typed.totpSecret")}
            </FieldLabel>
            <Input
              id={`${idPrefix}-totp-secret`}
              type="password"
              autoComplete="new-password"
              value={fields.secret ?? ""}
              onChange={(e) => onFieldChange("secret", e.target.value)}
              disabled={disabled}
              className="font-mono"
              placeholder={t("typed.totpSecretPlaceholder")}
            />
            <FieldDescription>{t("typed.totpSecretHint")}</FieldDescription>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-totp-issuer`}>
                {t("typed.totpIssuer")}
              </FieldLabel>
              <Input
                id={`${idPrefix}-totp-issuer`}
                value={fields.issuer ?? ""}
                onChange={(e) => onFieldChange("issuer", e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-totp-account`}>
                {t("typed.totpAccount")}
              </FieldLabel>
              <Input
                id={`${idPrefix}-totp-account`}
                value={fields.account ?? ""}
                onChange={(e) => onFieldChange("account", e.target.value)}
                disabled={disabled}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-totp-digits`}>
                {t("typed.totpDigits")}
              </FieldLabel>
              <Input
                id={`${idPrefix}-totp-digits`}
                type="number"
                inputMode="numeric"
                min={6}
                max={8}
                value={fields.digits ?? ""}
                onChange={(e) => onFieldChange("digits", e.target.value)}
                disabled={disabled}
                placeholder="6"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-totp-period`}>
                {t("typed.totpPeriod")}
              </FieldLabel>
              <Input
                id={`${idPrefix}-totp-period`}
                type="number"
                inputMode="numeric"
                min={15}
                max={120}
                value={fields.period ?? ""}
                onChange={(e) => onFieldChange("period", e.target.value)}
                disabled={disabled}
                placeholder="30"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-totp-algorithm`}>
                {t("typed.totpAlgorithm")}
              </FieldLabel>
              <Select
                value={fields.algorithm || "SHA1"}
                onValueChange={(v) => onFieldChange("algorithm", v)}
                disabled={disabled}
              >
                <SelectTrigger id={`${idPrefix}-totp-algorithm`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOTP_ALGORITHMS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </>
      ) : null}

      {kind === "CERTIFICATE" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-cert`}>
              {t("typed.certificate")}
            </FieldLabel>
            <Textarea
              id={`${idPrefix}-cert`}
              value={fields.certificate ?? ""}
              onChange={(e) => onFieldChange("certificate", e.target.value)}
              disabled={disabled}
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={t("typed.certificatePlaceholder")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-cert-private`}>
              {t("typed.certPrivateKey")}
            </FieldLabel>
            <Textarea
              id={`${idPrefix}-cert-private`}
              value={fields.privateKey ?? ""}
              onChange={(e) => onFieldChange("privateKey", e.target.value)}
              disabled={disabled}
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-cert-chain`}>
              {t("typed.certChain")}
            </FieldLabel>
            <Textarea
              id={`${idPrefix}-cert-chain`}
              value={fields.chain ?? ""}
              onChange={(e) => onFieldChange("chain", e.target.value)}
              disabled={disabled}
              rows={3}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
        </>
      ) : null}
    </>
  );
}
