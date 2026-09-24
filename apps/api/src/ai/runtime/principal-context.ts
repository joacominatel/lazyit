import { Injectable } from '@nestjs/common';
import {
  AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
  AiServiceAccountAccessSchema,
  type AiConversationChannel,
  type AiServiceAccountAccess,
  type AiToolClass,
  type Permission,
} from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { Principal } from '../../auth/principal';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiPromptPrincipal } from '../prompt/system-prompt';

/** The fleet-wide reporting-agent grant: an SA holding it never gets AI access (ADR-0097 default 16). */
export const AI_REFUSED_SA_PERMISSION: Permission = 'infra:report';

/** A principal cleared to run the assistant on a channel, with what narrows it. */
export interface AiRunPrincipal {
  principal: Principal;
  identity: DelegatedIdentity;
  channel: AiConversationChannel;
  owner: { userId: string | null; serviceAccountId: string | null };
  /** The class ceiling (headless `read-only` → `read`); undefined = none beyond the grants. */
  ceiling?: readonly AiToolClass[];
  /** Headless: the per-run cap on writes; null = none. */
  maxMutationsPerRun: number | null;
  /** What the frozen system prompt says about the principal (no ids). */
  prompt: AiPromptPrincipal;
}

/** Why a principal may not run the assistant now. `code` is a run error code. */
export interface AiRunPrincipalRefusal {
  code: 'FORBIDDEN';
  message: string;
}

export type AiRunPrincipalResult =
  | { ok: true; value: AiRunPrincipal }
  | { ok: false; refusal: AiRunPrincipalRefusal };

function refuse(message: string): AiRunPrincipalResult {
  return { ok: false, refusal: { code: 'FORBIDDEN', message } };
}

/**
 * Re-load and re-authorize the acting principal (provider-and-runtime.md §6.4 guardrails; INV-AI-1). Run
 * at submission and before EVERY step, so a deactivation, a `sessionEpoch` bump, a revoked `ai:use`, a
 * changed per-SA AI access setting or a newly granted `infra:report` takes effect at the next step
 * boundary. Tool calls are re-authorized again by core and the route's own guards.
 *
 * Channels (synthesis §1): `CHAT` is the human channel (writes need approval), `HEADLESS` is the Service
 * Account API (autonomous within its grants and its AI access setting). A human never runs headless and a
 * Service Account never runs the chat.
 */
@Injectable()
export class AiRunPrincipals {
  constructor(
    private readonly loader: PrincipalLoaderService,
    private readonly permissions: PermissionResolverService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(
    identity: DelegatedIdentity,
    channel: AiConversationChannel,
  ): Promise<AiRunPrincipalResult> {
    if (identity.kind === 'human') {
      if (channel !== 'CHAT') {
        return refuse('Headless runs are for Service Accounts only');
      }
      const loaded = await this.loader.loadHuman(
        identity.userId,
        identity.sessionEpoch,
      );
      if (!loaded.ok) return refuse('The acting principal is no longer valid');
      const user = loaded.principal.user;
      const granted = await this.permissions.resolve(user.role);
      if (!granted.has('ai:use')) {
        return refuse('The ai:use permission is required');
      }
      return {
        ok: true,
        value: {
          principal: loaded.principal,
          identity,
          channel,
          owner: { userId: user.id, serviceAccountId: null },
          maxMutationsPerRun: null,
          prompt: {
            kind: 'human',
            displayName: `${user.firstName} ${user.lastName}`,
            role: user.role,
            permissions: [...granted],
          },
        },
      };
    }

    if (channel !== 'HEADLESS') {
      return refuse('A Service Account uses the headless channel');
    }
    const loaded = await this.loader.loadServiceAccount(
      identity.serviceAccountId,
    );
    if (!loaded.ok) return refuse('The acting principal is no longer valid');
    const { serviceAccount, permissions } = loaded.principal;
    if (!permissions.has('ai:use')) {
      return refuse('The ai:use permission is required');
    }
    if (permissions.has(AI_REFUSED_SA_PERMISSION)) {
      return refuse(
        'A Service Account holding infra:report cannot use the AI assistant',
      );
    }
    const settings = await this.serviceAccountSettings(serviceAccount.id);
    if (settings.access === 'off') {
      return refuse('AI access is turned off for this Service Account');
    }
    return {
      ok: true,
      value: {
        principal: loaded.principal,
        identity,
        channel,
        owner: { userId: null, serviceAccountId: serviceAccount.id },
        ceiling: settings.access === 'read-only' ? ['read'] : undefined,
        maxMutationsPerRun: settings.maxMutationsPerRun,
        prompt: {
          kind: 'service',
          displayName: serviceAccount.name,
          permissions: [...permissions],
        },
      },
    };
  }

  /**
   * The SA's AI access setting (`ai_service_account_settings`, written by the headless unit). An absent
   * row reads as `read-write` with no cap (synthesis §6). Read-tolerant but restrictive: an access value
   * this build does not know (a newer build's) reads as `read-only`, and a malformed cap as no cap.
   */
  async serviceAccountSettings(serviceAccountId: string): Promise<{
    access: AiServiceAccountAccess;
    maxMutationsPerRun: number | null;
  }> {
    const row = await this.prisma.aiServiceAccountSettings.findUnique({
      where: { serviceAccountId },
    });
    if (!row) {
      return {
        access: AI_SERVICE_ACCOUNT_ACCESS_DEFAULT,
        maxMutationsPerRun: null,
      };
    }
    const access = AiServiceAccountAccessSchema.safeParse(row.access);
    const cap = row.maxMutationsPerRun;
    return {
      access: access.success ? access.data : 'read-only',
      maxMutationsPerRun:
        typeof cap === 'number' && Number.isInteger(cap) && cap >= 1
          ? cap
          : null,
    };
  }
}
