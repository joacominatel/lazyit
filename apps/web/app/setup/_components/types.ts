/**
 * The auth fork the wizard renders in step 1 (ADR-0043 §7a, ADR-0086 §6):
 *   - "zitadel" — the bundled, lazyit-managed Zitadel (zero-touch; the sidecar provisioned it).
 *   - "byoi"    — bring-your-own OIDC provider (the operator wires it via three env vars).
 *   - "local"   — first-party local auth (`AUTH_MODE=local`): NO external IdP; the first admin is
 *     created with a password. This is NOT operator-selectable in the wizard — the mode is fixed at
 *     deploy time and immutable, so in local mode the welcome step just explains it (no IdP picker).
 *
 * Distinct from the shared `IntegrationMode` ("zitadel" | "generic-oidc" | "local"): that is what the
 * SERVER authoritatively reports; this drives the wizard's step list + guidance copy. For OIDC modes
 * the operator may still pick between zitadel/byoi (it only changes copy); local has no choice to make.
 */
export type IdpChoice = "zitadel" | "byoi" | "local";
