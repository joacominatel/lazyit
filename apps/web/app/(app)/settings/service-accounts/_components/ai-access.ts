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

/** A positive int4 typed into the cap field, or null when it is not one. */
function parseCap(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const cap = Number(trimmed);
  return Number.isSafeInteger(cap) && cap >= 1 && cap <= 2_147_483_647 ? cap : null;
}

/**
 * The `PUT` body for the dialog's state. The cap is KEPT whatever the access level, so switching an
 * account to read-only (or off) and back does not silently erase it — it only bites on read-write.
 *   - limiting off → `maxMutationsPerRun: null`;
 *   - limiting on with a usable value → that value;
 *   - limiting on with an unusable value → `undefined` on read-write (the dialog blocks the save and
 *     says why); on the other levels the hidden, unusable cap is sent as null.
 */
export function aiAccessBody(
  access: AiServiceAccountAccess,
  capOn: boolean,
  capRaw: string,
): AiServiceAccountSettings | undefined {
  if (!capOn) return { access, maxMutationsPerRun: null };
  const cap = parseCap(capRaw);
  if (cap !== null) return { access, maxMutationsPerRun: cap };
  return access === "read-write" ? undefined : { access, maxMutationsPerRun: null };
}
