import { Injectable } from '@nestjs/common';
import {
  DEFAULT_PROBE_METHOD,
  type RestConnectionConfig,
  type RestStep,
} from '@lazyit/shared';
import { guardedFetch, type GuardedFetchOptions } from '../../common/egress';
import { mapData, renderTemplate } from '../mapping/data-mapper';
import {
  classifyThrownError,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  extractCorrelationId,
  httpErrorClass,
  joinUrl,
  redactHost,
} from './outbound-http';
import {
  isTransientStatus,
  type StepContext,
  type StepHandler,
  type StepResult,
  type TestConnectionContext,
  type TestConnectionResult,
} from './step-handler';

/**
 * REST connector handler (ADR-0054 §7) — the declarative HTTP tier that covers the Jira worked example
 * (create on grant, deactivate on revoke). Builds an HTTP request from the connection config (base
 * URL, auth scheme, default headers) + the step (method, path template, body data mapping), reveals
 * the credential in memory for auth, and calls out THROUGH the egress guard (`guardedFetch`) — which
 * enforces the v1 public-only posture (private/loopback/metadata denied by default; DNS-rebinding
 * pinned; redirects re-validated). It never logs secrets or bodies (INV-6).
 *
 * Retry posture mirrors `zitadel-management.service.ts`: a 4xx (other than 408/429) is PERMANENT
 * (`retryable: false`); a 5xx/429/408 or a network/timeout error is TRANSIENT — but only retryable
 * when the step is declared `idempotent`, so a non-idempotent create is single-shot (a lost-response
 * retry must not double-provision). The handler itself NEVER retries; it returns the flag for the CORE.
 */
@Injectable()
export class RestStepHandler implements StepHandler<
  RestConnectionConfig,
  RestStep
> {
  readonly kind = 'REST' as const;

  /**
   * Egress overrides — a TEST SEAM only (transport + DNS `lookup` doubles). Empty in production, so
   * `guardedFetch` uses the real pinning node transport + real DNS + deny-private (public-only v1).
   */
  egressOptions: Partial<GuardedFetchOptions> = {};

  async execute(
    ctx: StepContext<RestConnectionConfig, RestStep>,
  ): Promise<StepResult> {
    const { connection, step, data, meta } = ctx;

    // 1) Build the URL: fixed host from baseUrl + rendered (percent-encoded) relative path.
    const renderedPath = renderTemplate(step.path, data, 'url');
    const url = joinUrl(connection.baseUrl, renderedPath);
    const targetHost = redactHost(url);

    // 2) Headers: static default headers + auth (credential revealed in memory) + content-type.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      connection.defaultHeaders ?? {},
    )) {
      headers[name] = stripControlChars(value);
    }
    const authError = await applyAuth(headers, connection, ctx.revealSecret);
    if (authError) {
      return {
        status: 'FAILED',
        retryable: false,
        metadata: {
          method: step.method,
          targetHost,
          errorClass: 'config',
          reason: authError,
        },
      };
    }

    // 3) Body: JSON for the verbs that carry one; the mapper produces string leaves, JSON.stringify
    //    escapes them (no JSON-break injection from a ctx value).
    const carriesBody =
      step.method === 'POST' ||
      step.method === 'PUT' ||
      step.method === 'PATCH';
    const mapped = mapData(step.dataMapping, data, 'json');
    let body: string | undefined;
    if (carriesBody && mapped.fieldNames.length > 0) {
      body = JSON.stringify(mapped.values);
      headers['content-type'] = 'application/json';
    }

    // 4) Call out through the egress guard.
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await guardedFetch(
        url,
        { method: step.method, headers, body, signal: ctx.signal },
        {
          allowedProtocols: ['https:'],
          ...this.egressOptions,
          timeoutMs: meta.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS,
        },
      );
    } catch (err) {
      const { errorClass, reason, transient } = classifyThrownError(err);
      return {
        status: 'FAILED',
        retryable: transient && step.idempotent,
        metadata: {
          method: step.method,
          targetHost,
          durationMs: Date.now() - startedAt,
          errorClass,
          reason,
          mappedFields: mapped.fieldNames,
        },
      };
    }

    const durationMs = Date.now() - startedAt;

    // 5) Map status → result. 2xx success captures the correlation id; non-2xx classifies retryability.
    if (res.ok) {
      const externalCorrelationId = await extractCorrelationId(res);
      return {
        status: 'SUCCEEDED',
        externalCorrelationId,
        metadata: {
          method: step.method,
          targetHost,
          statusCode: res.status,
          durationMs,
          mappedFields: mapped.fieldNames,
        },
      };
    }

    const transient = isTransientStatus(res.status);
    return {
      status: 'FAILED',
      retryable: transient && step.idempotent,
      metadata: {
        method: step.method,
        targetHost,
        statusCode: res.status,
        durationMs,
        errorClass: httpErrorClass(res.status),
        reason: `upstream returned ${res.status}`,
        mappedFields: mapped.fieldNames,
      },
    };
  }

  /**
   * Side-effect-free connectivity probe (#344): a READ-ONLY GET/HEAD with auth applied, through the
   * egress guard. The probe targets `joinUrl(baseUrl, healthCheckPath)` when a `healthCheckPath` is
   * configured (many targets only 200 on `/health`, `/status`, `/api/healthz` — the root gives false
   * negatives), falling back to `baseUrl`. The HOST stays fixed by `baseUrl` (joinUrl never changes the
   * origin, anti-SSRF), the method is `healthCheckMethod` (GET default) which the shared schema bounds
   * to READ-ONLY verbs so the probe can never provision, and it still rides the same guard (https-only,
   * private/loopback/metadata denied, DNS-rebinding pinned, bounded deadline). Returns a redacted
   * diagnostic — never a body / secret — and echoes the probed `path` so the operator sees what was hit.
   */
  async testConnection(
    ctx: TestConnectionContext<RestConnectionConfig>,
  ): Promise<TestConnectionResult> {
    const { connection } = ctx;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      connection.defaultHeaders ?? {},
    )) {
      headers[name] = stripControlChars(value);
    }
    const authError = await applyAuth(headers, connection, ctx.revealSecret);
    if (authError) {
      return { ok: false, reason: authError };
    }
    // The probed target: the configured health path appended to the FIXED-host baseUrl, else baseUrl.
    // `joinUrl` only appends the path and normalizes slashes — it can never change the origin/host.
    const healthPath = connection.healthCheckPath?.trim();
    const url = healthPath
      ? joinUrl(connection.baseUrl, healthPath)
      : connection.baseUrl;
    const method = connection.healthCheckMethod ?? DEFAULT_PROBE_METHOD;
    const startedAt = Date.now();
    try {
      const res = await guardedFetch(
        url,
        { method, headers, signal: ctx.signal },
        {
          allowedProtocols: ['https:'],
          ...this.egressOptions,
          timeoutMs: ctx.meta.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS,
        },
      );
      return {
        ok: res.ok,
        statusCode: res.status,
        latencyMs: Date.now() - startedAt,
        probedPath: probedPathOf(url),
        reason: res.ok ? undefined : `upstream returned ${res.status}`,
      };
    } catch (err) {
      const { reason } = classifyThrownError(err);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        probedPath: probedPathOf(url),
        reason,
      };
    }
  }
}

/**
 * The non-secret path the probe targeted, derived for the redacted diagnostic so the operator sees
 * WHICH path was hit (the test-connection result, #344). Returns the pathname (+ search) of the probed
 * URL — never the host, never a credential (the path/query are static config, not a resolved ctx
 * value). Falls back to `/` when the URL can't be parsed.
 */
function probedPathOf(probedUrl: string): string {
  try {
    const u = new URL(probedUrl);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return '/';
  }
}

/**
 * Apply the configured auth scheme to the headers by revealing the credential in memory. Returns a
 * non-secret error string when the config is incomplete (e.g. HEADER scheme without a header name, or a
 * scheme that needs a secret but none is configured); `undefined` on success. NEVER logs the secret.
 */
async function applyAuth(
  headers: Record<string, string>,
  connection: RestConnectionConfig,
  revealSecret: () => Promise<string | null>,
): Promise<string | undefined> {
  const scheme = connection.authScheme;
  if (scheme === 'NONE') {
    return undefined;
  }
  const secret = await revealSecret();
  if (!secret) {
    return `auth scheme ${scheme} requires a credential, but none is configured`;
  }
  switch (scheme) {
    case 'BEARER':
      headers['authorization'] = `Bearer ${secret}`;
      return undefined;
    case 'BASIC':
      // The stored secret is the full `user:password` pair; we base64-encode it for Basic auth.
      headers['authorization'] =
        `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
      return undefined;
    case 'HEADER': {
      const name = connection.authHeaderName?.trim();
      if (!name) {
        return 'auth scheme HEADER requires authHeaderName in the connection config';
      }
      headers[name] = stripControlChars(secret);
      return undefined;
    }
    default:
      return `unsupported auth scheme: ${String(scheme)}`;
  }
}

/** Strip CR/LF + control chars from a header value (no header injection). */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}
