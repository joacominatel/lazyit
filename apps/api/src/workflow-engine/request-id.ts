/**
 * Read the per-request correlation id (ADR-0031) off the inbound request so the builder-support
 * endpoints (C3 test-connection, C4 dry-run) can surface it in their RESPONSE BODY — not just the
 * `X-Request-Id` response header. nestjs-pino's `genReqId` stamps the resolved id on `req.id` (honoring
 * an inbound `X-Request-Id`, else a fresh uuid); we fall back to the header and finally an empty string
 * so a missing logger middleware never throws. Pure + framework-light (no Express type coupling).
 */
export function requestIdOf(req: {
  id?: unknown;
  headers?: Record<string, unknown>;
}): string {
  if (typeof req.id === 'string') {
    return req.id;
  }
  if (typeof req.id === 'number') {
    return String(req.id);
  }
  const header = req.headers?.['x-request-id'];
  return typeof header === 'string' ? header : '';
}
