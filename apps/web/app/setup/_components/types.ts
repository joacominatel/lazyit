/**
 * The IdP fork the operator picks in step 1 of the setup wizard (ADR-0043 §7a):
 *   - "zitadel" — the bundled, lazyit-managed Zitadel (zero-touch; the sidecar provisioned it).
 *   - "byoi"    — bring-your-own OIDC provider (the operator wires it via three env vars).
 *
 * Distinct from the shared `IntegrationMode` ("zitadel" | "generic-oidc"): that is what the SERVER
 * authoritatively reports; this is the operator's UI selection, which only drives the guidance copy.
 */
export type IdpChoice = "zitadel" | "byoi";
