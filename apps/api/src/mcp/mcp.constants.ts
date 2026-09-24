/**
 * The fixed numbers of the MCP resource server (`/mcp`; ADR-0097 decision 9; mcp-and-oauth.md §5.3). A
 * change is a behavior decision, not a tuning knob.
 */

/** `tools/list` cache hint (2026-07-28 revision): private to the caller, one minute. */
export const MCP_TOOLS_LIST_TTL_MS = 60_000;

/**
 * The hard backstop on one tool result, serialized: past it the call answers `isError` guidance ("narrow
 * the query or page") instead of flooding the client. Core already truncates at write time
 * (`AI_TOOL_RESULT_MAX_CHARS`), so this only catches what grows in the envelope.
 */
export const MCP_RESULT_MAX_CHARS = 100_000;

/**
 * Per caller (a grant, or a Service Account), per replica, fixed one-minute windows (the OAuth rate-limit
 * posture): every `tools/call`, and the mutating ones separately (indicative values of §5.3).
 */
export const MCP_CALL_RATE_LIMIT = { max: 300, windowMs: 60_000 };
export const MCP_WRITE_RATE_LIMIT = { max: 60, windowMs: 60_000 };

/** Per caller: every authenticated `/mcp` HTTP request (listings included) — a coarse HTTP backstop. */
export const MCP_REQUEST_RATE_LIMIT = { max: 600, windowMs: 60_000 };

/** The rolling window of a Service Account's `maxMutationsPerRun` cap over MCP (G3 review F2). */
export const MCP_SA_WRITE_CAP_WINDOW_MS = 60 * 60_000;

/** Per client IP: refused authentications (each costs a DB lookup). */
export const MCP_AUTH_FAILURE_RATE_LIMIT = { max: 30, windowMs: 60_000 };

/**
 * An MCP invocation still `EXECUTING` this long after its last update was interrupted (the process died
 * mid-call): it becomes `OUTCOME_UNKNOWN` and is never retried. Far longer than any HTTP request lives.
 */
export const MCP_EXECUTING_STALE_AFTER_MS = 15 * 60_000;

/** How often the stuck-invocation sweep runs, and its batch size. */
export const MCP_SWEEP_INTERVAL_MS = 5 * 60_000;
export const MCP_SWEEP_BATCH = 100;

/** The `serverInfo` the MCP server announces. No build version: ADR-0083 keeps it non-anonymous. */
export const MCP_SERVER_INFO = { name: 'lazyit', version: '1.0.0' } as const;
