import type { WorkflowStep } from "@lazyit/shared";

/**
 * The CLIENT-derived context-token catalog for the data-mapping field picker (issue #300, frontend.md
 * §5a / C6). This is the FE-ONLY mirror of the engine's token grammar — it is NOT the shared
 * context-token catalog (issue #284, deferred). Promoting it to `@lazyit/shared` would imply the backend
 * validates a mapping against it, which v1 deliberately does not (the mapping stays a free template
 * string; the executor resolves a frozen, allowlisted context).
 *
 * The picker exists so an operator chooses a value source by NAME instead of hand-typing
 * `{{ grantee.email }}`; the chosen token is rendered back into the same `{{ … }}` template string the
 * advanced (raw) mode edits, so both modes write the identical persisted value.
 *
 * Scope guardrail (anti-IGA, ADR-0054 §6.c / frontend.md §5b): the catalog offers ONLY fields that exist
 * on the lazyit model today — name/email/id, application, grant, run context. There is NO
 * `role`/`team`/`manager`/AD token — surfacing one would either dangle (no data) or pressure the User
 * model into an HR/identity-governance graph. The manual-task path is the v1 answer for "which team?".
 */

/** A token group key — used as the picker's section heading (i18n `workflow.tokenGroup.<group>`). */
export type ContextTokenGroup =
  | "event"
  | "grantee"
  | "application"
  | "grant"
  | "steps";

/** A single selectable value source. `path` is the dotted token (e.g. `grantee.email`). */
export interface ContextToken {
  group: ContextTokenGroup;
  /** The dotted token path the template references (e.g. `grantee.email`, `steps.step-1.id`). */
  path: string;
  /** A short, human label for the row (the leaf name; the group is the section heading). */
  label: string;
}

/**
 * The STATIC token catalog — a faithful mirror of the engine's frozen mapping context
 * (`apps/api/src/workflow-engine/run/run-context.ts`, `WorkflowMappingContext`): the trigger `event`
 * (a scalar — `ACCESS_GRANTED` / `ACCESS_REVOKED`), the `grantee`, the `application` (only `id` + `name`),
 * and the `grant`. These are exactly the roots the server mapper allows (`ALLOWED_ROOTS` =
 * `{ event, grantee, application, grant, steps }`); offering anything outside that set would dangle —
 * it would resolve to an empty string at run time with no error. There is deliberately NO `context`
 * root and NO `application.vendor`/`url` (the engine context carries neither), and NO
 * `role`/`team`/`manager` token (anti-IGA, ADR-0054 §6.c). Both v1 triggers resolve the same shape,
 * so the static set does not branch on the trigger today.
 */
const STATIC_TOKENS: ContextToken[] = [
  { group: "event", path: "event", label: "Trigger event" },
  { group: "grantee", path: "grantee.email", label: "Email" },
  { group: "grantee", path: "grantee.firstName", label: "First name" },
  { group: "grantee", path: "grantee.lastName", label: "Last name" },
  { group: "grantee", path: "grantee.id", label: "User id" },
  { group: "application", path: "application.name", label: "Name" },
  { group: "application", path: "application.id", label: "Application id" },
  { group: "grant", path: "grant.accessLevel", label: "Access level" },
  { group: "grant", path: "grant.grantedAt", label: "Granted at" },
  { group: "grant", path: "grant.expiresAt", label: "Expires at" },
  { group: "grant", path: "grant.id", label: "Grant id" },
];

/**
 * Derive the per-step output tokens from the EARLIER steps in the graph. A step that already ran can
 * feed a later one — a REST/WEBHOOK step exposes its response under `steps.<key>.*`; a MANUAL step
 * exposes each input field the human filled under `steps.<key>.<fieldName>`. Only steps BEFORE the one
 * being edited are offered (a step cannot consume its own / a later step's output). Frontend.md §5a
 * names prior-step outputs + manual inputs as first-class value sources.
 */
function priorStepTokens(priorSteps: readonly WorkflowStep[]): ContextToken[] {
  const tokens: ContextToken[] = [];
  for (const step of priorSteps) {
    const stepName = step.name?.trim() || step.key;
    if (step.kind === "MANUAL") {
      for (const field of step.inputFields) {
        tokens.push({
          group: "steps",
          path: `steps.${step.key}.${field.name}`,
          label: `${stepName} · ${field.label || field.name}`,
        });
      }
    } else {
      // REST / WEBHOOK_OUT — the response body / id the step returned.
      tokens.push({
        group: "steps",
        path: `steps.${step.key}.response`,
        label: `${stepName} · response`,
      });
    }
  }
  return tokens;
}

/**
 * Build the full, ordered token list available to a step's data mapping: the static
 * event/grantee/application/grant tokens, then the output tokens of every step BEFORE it. `priorSteps`
 * are the steps that precede the edited one in array order (the only ones whose output is in scope).
 */
export function buildContextTokens(
  priorSteps: readonly WorkflowStep[] = [],
): ContextToken[] {
  return [...STATIC_TOKENS, ...priorStepTokens(priorSteps)];
}

/** The `{{ token }}` template a chosen token writes (the same string the advanced/raw mode edits). */
export function tokenToTemplate(path: string): string {
  return `{{ ${path} }}`;
}

/**
 * Parse a raw mapping value back to a single token PATH when it is exactly one `{{ token }}` reference
 * (so re-opening a saved mapping shows the picker selection). Returns `undefined` for a literal, an
 * empty value, or a composite template (those only round-trip through the advanced raw mode).
 */
export function templateToToken(value: string): string | undefined {
  const match = value.trim().match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
  return match ? match[1] : undefined;
}
