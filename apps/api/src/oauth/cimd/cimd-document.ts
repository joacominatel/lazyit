import { isRegistrableRedirectUri, redirectHost } from '../client-policy';
import { sanitizeClientName, sanitizeClientUri } from '../client-display';
import { DCR_MAX_REDIRECT_URIS, DCR_UNNAMED_CLIENT } from '../oauth.constants';

/**
 * Why a Client ID Metadata Document was not accepted. Machine-readable, recorded in the OAuth audit trail
 * (`CLIENT_METADATA_REFUSED`), never shown to the end user verbatim.
 */
export type CimdRefusalReason =
  /** The egress guard refused the target, DNS failed, the connection failed or timed out. */
  | 'fetch_failed'
  /** A redirect (never followed) or any status other than 200. */
  | 'http_status'
  /** The response is not JSON (`application/json` or `application/*+json`). */
  | 'content_type'
  /** The body is larger than the read limit. */
  | 'too_large'
  /** The body is not a JSON object. */
  | 'malformed'
  /** The document's `client_id` is not exactly the URL it was fetched from. */
  | 'client_id_mismatch'
  /** The document carries `client_secret` / `client_secret_expires_at`. */
  | 'client_secret'
  /** A `token_endpoint_auth_method` other than `none` (lazyit serves public clients only). */
  | 'auth_method'
  /** `redirect_uris` missing, empty, too many, or one that is never registrable. */
  | 'redirect_uris'
  /** `grant_types` / `response_types` outside what lazyit supports. */
  | 'grant_types'
  /** Too many network fetches by this user in the current window. */
  | 'rate_limited';

export class CimdRefusal extends Error {
  /**
   * @param networkFailure true when the refusal says nothing about what the client's host publishes — the
   *   host could not be reached, answered with a transient error, redirected, or served a non-JSON page (a
   *   captive portal or an intercepting proxy). Only such a failure may fall back to a bundled copy; a JSON
   *   document the host really served that fails validation, and a definitive status (404, 410, 403…),
   *   are refused.
   */
  constructor(
    readonly reason: CimdRefusalReason,
    message: string,
    readonly networkFailure = false,
  ) {
    super(message);
    this.name = 'CimdRefusal';
  }
}

/** The sanitized document lazyit keeps — only the fields it understands, never keys or secrets. */
export interface CimdDocument {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  application_type?: string;
  software_id?: string;
  software_version?: string;
}

const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
/** Credential properties a metadata document MUST NOT carry (draft §"Credential and Key Material Restrictions"). */
const FORBIDDEN_PROPERTIES = ['client_secret', 'client_secret_expires_at'];

function stringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    !value.every((item) => typeof item === 'string' && item.length <= 64)
  ) {
    return null;
  }
  return value as string[];
}

/**
 * Validate a fetched (or bundled) Client ID Metadata Document against the draft and lazyit's public-client
 * policy, and reduce it to {@link CimdDocument}. Throws {@link CimdRefusal}.
 *
 *   - `client_id` MUST equal the Client Identifier URL, by simple string comparison.
 *   - No `client_secret` / `client_secret_expires_at`; `token_endpoint_auth_method` absent or `none`
 *     (lazyit has no client authentication, so `private_key_jwt` is refused too).
 *   - `redirect_uris` present, 1..10, every one registrable (https, loopback http, or a private-use scheme;
 *     no fragment, no userinfo) — the same bar as DCR. Whether they are ADMITTED is the allowlist's call,
 *     made later against the stored row.
 *   - `grant_types` / `response_types`, when present, within `authorization_code` (+ `refresh_token`) / `code`.
 *   - Display fields are sanitized (`client_name` control/bidi-stripped and capped; `client_uri` kept only
 *     when https); `logo_uri`, `jwks`, `jwks_uri` and every other property are dropped — nothing referenced
 *     by the document is ever fetched.
 */
export function parseClientMetadataDocument(
  raw: unknown,
  clientId: string,
): CimdDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CimdRefusal('malformed', 'The document is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;

  if (doc.client_id !== clientId) {
    throw new CimdRefusal(
      'client_id_mismatch',
      'The document client_id does not match the URL it was fetched from',
    );
  }
  if (FORBIDDEN_PROPERTIES.some((key) => key in doc)) {
    throw new CimdRefusal(
      'client_secret',
      'A client metadata document must not carry a client secret',
    );
  }
  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    throw new CimdRefusal(
      'auth_method',
      'Only public clients are supported (token_endpoint_auth_method "none")',
    );
  }

  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > DCR_MAX_REDIRECT_URIS ||
    !redirectUris.every((uri) => typeof uri === 'string')
  ) {
    throw new CimdRefusal(
      'redirect_uris',
      `redirect_uris must list between 1 and ${DCR_MAX_REDIRECT_URIS} URIs`,
    );
  }
  const uris = [...new Set(redirectUris)];
  if (!uris.every((uri) => isRegistrableRedirectUri(uri))) {
    throw new CimdRefusal(
      'redirect_uris',
      'Redirect URIs must be https://, http:// on a loopback address, or a private-use app scheme',
    );
  }

  if (doc.grant_types !== undefined) {
    const grantTypes = stringArray(doc.grant_types);
    if (
      grantTypes === null ||
      !grantTypes.includes('authorization_code') ||
      grantTypes.some((type) => !SUPPORTED_GRANT_TYPES.includes(type))
    ) {
      throw new CimdRefusal(
        'grant_types',
        'grant_types must be authorization_code, optionally with refresh_token',
      );
    }
  }
  if (doc.response_types !== undefined) {
    const responseTypes = stringArray(doc.response_types);
    if (
      responseTypes === null ||
      responseTypes.length === 0 ||
      responseTypes.some((type) => type !== 'code')
    ) {
      throw new CimdRefusal('grant_types', 'response_types must be ["code"]');
    }
  }

  // A document without a usable name is shown under its verified host, never as "Unnamed client".
  let name = sanitizeClientName(doc.client_name);
  if (name === DCR_UNNAMED_CLIENT && doc.client_name !== DCR_UNNAMED_CLIENT) {
    name = new URL(clientId).host;
  }

  return {
    client_id: clientId,
    client_name: name,
    client_uri: sanitizeClientUri(doc.client_uri),
    redirect_uris: uris,
    grant_types: SUPPORTED_GRANT_TYPES,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(typeof doc.application_type === 'string' &&
    ['native', 'web'].includes(doc.application_type)
      ? { application_type: doc.application_type }
      : {}),
    ...(typeof doc.software_id === 'string'
      ? { software_id: sanitizeClientName(doc.software_id).slice(0, 200) }
      : {}),
    ...(typeof doc.software_version === 'string'
      ? {
          software_version: sanitizeClientName(doc.software_version).slice(
            0,
            64,
          ),
        }
      : {}),
  };
}

/** The redirect hosts of a document, for the audit trail (never the full URIs' queries). */
export function documentRedirectHosts(doc: CimdDocument): string[] {
  return doc.redirect_uris.map(redirectHost);
}
