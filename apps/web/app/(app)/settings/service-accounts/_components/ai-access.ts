import type {
  AiServiceAccountAccess,
  AiServiceAccountSettings,
  Permission,
} from "@lazyit/shared";

/**
 * Pure logic behind a Service Account's AI access (ADR-0097 decision 4; frontend.md §5.3 "Headless";
 * mcp-and-oauth.md §14). The setting only NARROWS what the account's grants allow — it never grants a
 * permission — so the dialog explains what else the account needs, and what refuses it anyway.
 */

/** Why the chosen access may not take effect, as keys under `settings.serviceAccounts.aiAccess.notes`. */
export type AiAccessNote = "infraReport" | "noAiUse" | "noAiConnect";

/**
 * The notes for an account holding `permissions` with `access`. With access `off` there is nothing to
 * explain. Otherwise:
 *   - `infraReport` — the fleet-wide agent credential is refused by the runtime and by `/mcp` whatever
 *     this setting says (security.md T-35);
 *   - `noAiUse`     — headless runs (`POST /ai/runs`) need `ai:use`;
 *   - `noAiConnect` — `/mcp` needs `ai:connect`.
 */
export function aiAccessNotes(
  permissions: readonly Permission[],
  access: AiServiceAccountAccess,
): AiAccessNote[] {
  if (access === "off") return [];
  const held = new Set<string>(permissions);
  const notes: AiAccessNote[] = [];
  if (held.has("infra:report")) notes.push("infraReport");
  if (!held.has("ai:use")) notes.push("noAiUse");
  if (!held.has("ai:connect")) notes.push("noAiConnect");
  return notes;
}

/**
 * The `PUT` body for the dialog's state: the cap only when limiting writes is on and the typed value is
 * a positive integer — `null` otherwise, or `undefined` when the cap is on but unusable (the dialog
 * blocks the save). A cap means nothing with access `off` or `read-only`, so it is sent as null.
 */
export function aiAccessBody(
  access: AiServiceAccountAccess,
  capOn: boolean,
  capRaw: string,
): AiServiceAccountSettings | undefined {
  if (access !== "read-write" || !capOn) return { access, maxMutationsPerRun: null };
  const trimmed = capRaw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const cap = Number(trimmed);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 2_147_483_647) return undefined;
  return { access, maxMutationsPerRun: cap };
}
