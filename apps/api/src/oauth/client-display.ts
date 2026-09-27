import { DCR_UNNAMED_CLIENT } from './oauth.constants';

/**
 * Sanitizers for the self-declared display fields of a client — a DCR registration request or a CIMD
 * metadata document. Pure functions (no Nest, no Prisma) so both paths share them.
 */

const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A display name: control and bidi characters stripped, trimmed, capped. Self-declared, never trusted. */
export function sanitizeClientName(value: unknown): string {
  if (typeof value !== 'string') return DCR_UNNAMED_CLIENT;
  const cleaned = value.replace(CONTROL_CHARS, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : DCR_UNNAMED_CLIENT;
}

/** An https `client_uri` is kept for display; anything else is dropped rather than refused. */
export function sanitizeClientUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username === '' &&
      url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
