/**
 * The auth fork the wizard renders (ADR-0086 §6, ADR-0102):
 *   - "byoi"  — the operator's own OIDC provider, wired by environment variables.
 *   - "local" — first-party local auth (`AUTH_MODE=local`): the first admin is created with a password.
 *
 * Neither is operator-selectable here: the auth mode is fixed at deploy time and immutable, so the
 * server's `IntegrationMode` decides it and this type only drives the step list and the copy.
 */
export type IdpChoice = "byoi" | "local";
