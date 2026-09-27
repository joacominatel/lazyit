/**
 * The DELEGATED IDENTITY an in-process AI tool call runs as (ADR-0097; docs/ai-assistant/_synthesis.md R1,
 * tools-and-execution.md §5 Fork C3).
 *
 * The AI tool dispatcher runs a controller handler through Nest's own guard and pipe pipeline with a
 * SYNTHETIC request. That request names the invoking principal under a module-private `unique symbol`,
 * and {@link JwtAuthGuard} re-loads the principal from the database exactly as the network branches do.
 *
 * Why this cannot be reached from the network:
 *   - the key is a `Symbol()` (NOT `Symbol.for`), and it is not exported — only the two functions below
 *     can read or write it;
 *   - an HTTP request can only produce string-keyed data (headers, query, JSON body, params); no parser
 *     turns input into a symbol-keyed property of the request object;
 *   - the reader checks an OWN property, so nothing on the prototype chain can supply it.
 *
 * Only the AI tool dispatcher (`ai/core/tool-dispatcher.ts`) attaches it and only the guard reads it —
 * `delegated-identity.spec.ts` fails if any other production file imports this module.
 *
 * The identity carries ids, never a loaded row: the guard re-reads the user or service account on every
 * call, so a deactivation, an offboarding, a revoked or expired account, or a `sessionEpoch` bump takes
 * effect on the next tool call.
 */
export type DelegatedIdentity =
  | {
      kind: 'human';
      userId: string;
      /**
       * The `sessionEpoch` the delegation was granted under: the chat session's, or — for an MCP
       * request — the live value `/mcp` re-read when it verified the credential (the credential itself is
       * bound to `mcpCredentialEpoch`, ADR-0097 decision 8 as amended). Any bump since — logout, password
       * change, deactivation — refuses the call, exactly as it revokes a local session token.
       */
      sessionEpoch: number;
    }
  | { kind: 'service'; serviceAccountId: string };

const DELEGATED_IDENTITY: unique symbol = Symbol('lazyit.delegatedIdentity');

/**
 * Attach a delegated identity to a synthetic request. Non-enumerable, non-writable and
 * non-configurable, so it cannot be serialized, overwritten or removed after the dispatcher sets it.
 */
export function attachDelegatedIdentity(
  request: object,
  identity: DelegatedIdentity,
): void {
  Object.defineProperty(request, DELEGATED_IDENTITY, {
    value: Object.freeze({ ...identity }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/** Whether the request carries a delegated identity at all (an OWN property — never inherited). */
export function hasDelegatedIdentity(request: object): boolean {
  return Object.prototype.hasOwnProperty.call(request, DELEGATED_IDENTITY);
}

/**
 * The delegated identity on the request, or `null` when the property is present but malformed (the
 * guard refuses it: fail closed). Call only after {@link hasDelegatedIdentity} returned true.
 */
export function readDelegatedIdentity(
  request: object,
): DelegatedIdentity | null {
  const value: unknown = (request as Record<symbol, unknown>)[
    DELEGATED_IDENTITY
  ];
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'human' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.sessionEpoch === 'number' &&
    Number.isInteger(candidate.sessionEpoch)
  ) {
    return {
      kind: 'human',
      userId: candidate.userId,
      sessionEpoch: candidate.sessionEpoch,
    };
  }
  if (
    candidate.kind === 'service' &&
    typeof candidate.serviceAccountId === 'string'
  ) {
    return { kind: 'service', serviceAccountId: candidate.serviceAccountId };
  }
  return null;
}
