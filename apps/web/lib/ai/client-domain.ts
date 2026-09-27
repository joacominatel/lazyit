/**
 * How an OAuth client is identified to the person approving or reviewing it (consent page, Account →
 * AI & connected apps). docs/ai-assistant/mcp-and-oauth.md §15, security.md §6.3 / G4.
 *
 * Two different things, kept visually apart:
 * - the client's **name** is self-declared — whatever its registration or metadata document says;
 * - its **domain** (`client.verifiedDomain`, CIMD clients only) is the host of the `client_id` URL whose
 *   metadata document lazyit fetched — the part lazyit actually proved.
 *
 * `client.verified` (the green "Verified" badge) is stricter still: only a CIMD client on the instance's
 * allowlist. A client can have a proven domain and still be unverified; it then keeps the extra
 * confirmation at consent.
 */

/**
 * The domain to show next to the client's name, or null when there is none to show — a DCR client, or
 * an older API without the field. Tolerant on read: anything that is not a non-empty string is null.
 */
export function clientDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim();
  return domain.length > 0 ? domain : null;
}
