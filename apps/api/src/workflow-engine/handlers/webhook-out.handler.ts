import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  WebhookOutConnectionConfig,
  WebhookOutStep,
} from '@lazyit/shared';
import { guardedFetch, type GuardedFetchOptions } from '../../common/egress';
import { mapData } from '../mapping/data-mapper';
import {
  classifyThrownError,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  extractCorrelationId,
  httpErrorClass,
  redactHost,
} from './outbound-http';
import {
  isTransientStatus,
  type StepContext,
  type StepHandler,
  type StepResult,
} from './step-handler';

/**
 * WEBHOOK_OUT connector handler (ADR-0054 §7) — a signed POST to one configured URL. This is the seam
 * that later reaches an operator's own n8n / Make / Zapier (the long-tail bridge), so an external app
 * with no direct API can still be part of an automated, audited flow.
 *
 * Builds a JSON payload from the step's data mapping, optionally signs the raw body with HMAC-SHA256
 * (a `WorkflowSecret` signing key → a `<signatureHeader>: sha256=<hex>` header the receiver verifies),
 * and POSTs it through the egress guard (public-only v1). Never logs the secret or the body (INV-6).
 * Retry posture mirrors the REST handler: a 4xx (other than 408/429) is PERMANENT; a 5xx/429/408 or a
 * network/timeout error is TRANSIENT — but only retryable when the step is declared `idempotent`, so a
 * non-idempotent delivery is single-shot (a lost-response retry must not double-fire the receiver).
 */
@Injectable()
export class WebhookOutStepHandler implements StepHandler<
  WebhookOutConnectionConfig,
  WebhookOutStep
> {
  readonly kind = 'WEBHOOK_OUT' as const;

  /** Egress overrides — a TEST SEAM only (transport + DNS `lookup` doubles). Empty in production. */
  egressOptions: Partial<GuardedFetchOptions> = {};

  async execute(
    ctx: StepContext<WebhookOutConnectionConfig, WebhookOutStep>,
  ): Promise<StepResult> {
    const { connection, step, data, meta } = ctx;
    const targetHost = redactHost(connection.url);

    // 1) Build the JSON event payload from the data mapping (string leaves, JSON.stringify-escaped).
    const mapped = mapData(step.dataMapping, data, 'json');
    const body = JSON.stringify(mapped.values);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    // 2) Optional HMAC signature over the raw body (signing key revealed in memory).
    let signed = false;
    if (connection.signatureHeader) {
      const secret = await ctx.revealSecret();
      if (!secret) {
        return {
          status: 'FAILED',
          retryable: false,
          metadata: {
            method: 'POST',
            targetHost,
            errorClass: 'config',
            reason:
              'a signatureHeader is configured but no signing secret is set',
            mappedFields: mapped.fieldNames,
          },
        };
      }
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      headers[connection.signatureHeader] = `sha256=${signature}`;
      signed = true;
    }

    // 3) POST through the egress guard.
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await guardedFetch(
        connection.url,
        { method: 'POST', headers, body, signal: ctx.signal },
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
          method: 'POST',
          targetHost,
          durationMs: Date.now() - startedAt,
          errorClass,
          reason,
          mappedFields: mapped.fieldNames,
          signed,
        },
      };
    }

    const durationMs = Date.now() - startedAt;
    if (res.ok) {
      const externalCorrelationId = await extractCorrelationId(res);
      return {
        status: 'SUCCEEDED',
        externalCorrelationId,
        metadata: {
          method: 'POST',
          targetHost,
          statusCode: res.status,
          durationMs,
          mappedFields: mapped.fieldNames,
          signed,
        },
      };
    }

    return {
      status: 'FAILED',
      retryable: isTransientStatus(res.status) && step.idempotent,
      metadata: {
        method: 'POST',
        targetHost,
        statusCode: res.status,
        durationMs,
        errorClass: httpErrorClass(res.status),
        reason: `receiver returned ${res.status}`,
        mappedFields: mapped.fieldNames,
        signed,
      },
    };
  }
}
