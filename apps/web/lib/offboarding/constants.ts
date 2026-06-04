/**
 * Shared constants for the Offboarding flow (Wave 3b): the Sheet (in-app confirmation) and the
 * printable Return Act read these so the two surfaces never drift apart.
 *
 * Persistence is localStorage-only for v1 (CEO-ratified): the message is a reusable, app-level
 * template (not per-user) so a team writes their handover note once and it pre-fills every act; the
 * org name is a single self-hosted setting until a real org-config endpoint exists.
 */

/** App-level (not per-user) handover message template. Reused across every offboarding act. */
export const OFFBOARDING_MESSAGE_KEY = "lazyit:offboarding:message";

/** The self-hosted org's display name, printed on the act letterhead. v1: a local setting. */
export const ORG_NAME_KEY = "lazyit:org:name";

/** Sensible default handover note — the calm, respectful house voice. */
export const DEFAULT_OFFBOARDING_MESSAGE =
  "Please return all listed equipment in working condition. Access to the systems below has been revoked as of today. Thank you for your contributions.";

/** Default org name until the operator sets one. */
export const DEFAULT_ORG_NAME = "lazyit";
