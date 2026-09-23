import { Injectable } from '@nestjs/common';
import type { AiChannel, AiToolResult, Permission } from '@lazyit/shared';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { Principal } from '../../auth/principal';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';
import { callKindOf, errorResult } from './result-shaper';
import { AiToolExecutor } from './tool-executor';
import { AiToolRegistry } from './tool-registry';
import type {
  AiExecutionContext,
  AiToolListing,
  RegisteredAiTool,
} from './tool-descriptor';

/** The permission that opens each channel (synthesis §1): `ai:use` for chat and headless, `ai:connect` for MCP. */
function channelPermission(channel: AiChannel): Permission {
  return channel === 'MCP' ? 'ai:connect' : 'ai:use';
}

/**
 * The ONLY façade channels use to reach tools (synthesis §4.2). On top of the Nest pipeline every tool
 * call already runs through, it re-checks per call:
 *   - the principal, re-loaded from the database (a stale or revoked identity is refused);
 *   - `ai:use` (chat, headless) or `ai:connect` (MCP), held NOW;
 *   - the channel the tool allows;
 *   - the class ceiling (the MCP scope or the Service Account's AI access setting).
 *
 * Writes (`write`, `elevated`) are refused by `invoke` on every channel. In the chat a write is never
 * invoked directly — it is proposed and runs only after the user approves it, so a loop bug cannot skip
 * confirmation. Over MCP and headless a write must land in the permanent `AiActionLog` ledger (R6,
 * INV-AI-10); until that ledger-backed path is installed, `invoke` fails closed.
 */
@Injectable()
export class AiToolService {
  constructor(
    private readonly registry: AiToolRegistry,
    private readonly executor: AiToolExecutor,
    private readonly principals: PrincipalLoaderService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * The tools this principal may call through this channel, in a deterministic order. Filtered by the
   * channel, the class ceiling, the principal kind the route's guards admit, and a static check of the
   * route's `@RequirePermission` — the same decision `RolesGuard` makes at call time.
   */
  async list(ctx: AiExecutionContext): Promise<AiToolListing[]> {
    const principal = await this.loadPrincipal(ctx);
    if (!principal) return [];
    if (!(await this.holds(principal, [channelPermission(ctx.channel)]))) {
      return [];
    }
    const listing: AiToolListing[] = [];
    for (const tool of this.registry.all()) {
      if (!this.reachable(tool, ctx)) continue;
      if (!this.admitsKind(tool, principal)) continue;
      if (!(await this.holds(principal, tool.permissions))) continue;
      listing.push({
        name: tool.descriptor.name,
        title: tool.descriptor.title,
        description: tool.descriptor.description,
        class: tool.descriptor.class,
        inputSchema: tool.inputSchema,
        permissions: tool.permissions,
        annotations: tool.annotations,
      });
    }
    return listing;
  }

  /**
   * Run a tool now. Reads on every channel the tool allows; writes are refused (see the class comment).
   * The route's own authorization runs inside the dispatch — this method never decides a route permission.
   */
  async invoke(
    name: string,
    input: unknown,
    ctx: AiExecutionContext,
  ): Promise<AiToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return errorResult('read', {
        code: 'NOT_AVAILABLE',
        message: `Unknown tool: ${name}`,
      });
    }
    const kind = callKindOf(tool.descriptor.class);
    if (!tool.channels.includes(ctx.channel)) {
      return errorResult(kind, {
        code: 'NOT_AVAILABLE',
        message: `${name} is not available on this channel`,
      });
    }
    if (ctx.ceiling && !ctx.ceiling.includes(tool.descriptor.class)) {
      return errorResult(kind, {
        code: 'FORBIDDEN',
        status: 403,
        message: `${name} is outside the access granted to this session`,
      });
    }
    if (kind === 'mutation') {
      return errorResult(kind, {
        code: 'NOT_AVAILABLE',
        message:
          ctx.channel === 'CHAT'
            ? `${name} changes data: it must be proposed and approved, not invoked`
            : `${name} changes data, and writes are not enabled on this channel`,
      });
    }
    const principal = await this.loadPrincipal(ctx);
    if (!principal) {
      return errorResult(kind, {
        code: 'FORBIDDEN',
        status: 401,
        message: 'The acting principal is no longer valid',
      });
    }
    const gate = channelPermission(ctx.channel);
    if (!(await this.holds(principal, [gate]))) {
      return errorResult(kind, {
        code: 'FORBIDDEN',
        status: 403,
        message: `The ${gate} permission is required`,
      });
    }
    return this.executor.execute(tool, input, ctx);
  }

  private reachable(tool: RegisteredAiTool, ctx: AiExecutionContext): boolean {
    if (!tool.channels.includes(ctx.channel)) return false;
    return !ctx.ceiling || ctx.ceiling.includes(tool.descriptor.class);
  }

  private admitsKind(tool: RegisteredAiTool, principal: Principal): boolean {
    return principal.kind === 'service'
      ? tool.principalKinds.service
      : tool.principalKinds.human;
  }

  private async loadPrincipal(
    ctx: AiExecutionContext,
  ): Promise<Principal | null> {
    const identity = ctx.identity;
    const loaded =
      identity.kind === 'human'
        ? await this.principals.loadHuman(
            identity.userId,
            identity.sessionEpoch,
          )
        : await this.principals.loadServiceAccount(identity.serviceAccountId);
    return loaded.ok ? loaded.principal : null;
  }

  private async holds(
    principal: Principal,
    required: readonly Permission[],
  ): Promise<boolean> {
    if (principal.kind === 'service') {
      return required.every((p) => principal.permissions.has(p));
    }
    return this.permissions.hasAll(principal.user.role, required);
  }
}
