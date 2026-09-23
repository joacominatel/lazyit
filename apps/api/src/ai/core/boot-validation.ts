import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RouteParamtypes } from '@nestjs/common/internal';
import {
  AI_CHANNELS,
  AI_TOOL_CLASSES,
  AI_TOOL_NAME_PATTERN,
  type AiChannel,
  type AiToolAnnotations,
} from '@lazyit/shared';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import { HumanOnlyGuard } from '../../secret-manager/human-only.guard';
import { ServiceOnlyGuard } from '../../secret-manager/service-only.guard';
import { isExcludedHandler, isExcludedPath } from './exclusions';
import { isController, readRoute, type RouteInfo } from './route-metadata';
import type {
  AiToolDescriptor,
  AiToolset,
  HandlerRef,
  RegisteredAiTool,
} from './tool-descriptor';

/**
 * BOOT-TIME REGISTRY VALIDATION (tools-and-execution.md §8.3; synthesis §4.1). The API refuses to start
 * when a toolset is wrong, so a bad tool can never be served. Every problem is collected and reported at
 * once.
 *
 * A binding must be a real route that the in-process dispatcher can run with no loss of enforcement:
 *   - not `@Public()` (a tool always acts as a principal);
 *   - no `@Res`/`@Next`/upload/raw-body/session parameter and no interceptor (the upload handlers);
 *   - only handler guards whose meaning the dispatcher preserves: the principal-kind guards. A guard keyed
 *     on the network (the per-IP rate limiters) is refused;
 *   - not a structural exclusion (`exclusions.ts`: Secret Manager, cleartext credentials, the AI's own
 *     configuration).
 * A tool must have a valid unique name, a known class, a JSON-Schema-representable object input, a
 * preview when it writes, and channels its class allows. An `unexposed` entry must name a real route
 * handler that no tool binds.
 */

export class AiToolRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `AI tool registry is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'AiToolRegistryError';
  }
}

/** Handler guards the dispatcher runs unchanged and that only look at the principal. */
const ALLOWED_HANDLER_GUARDS: readonly unknown[] = [
  ServicePrincipalForbiddenGuard,
  HumanOnlyGuard,
  ServiceOnlyGuard,
];

/** Parameter kinds a synthetic request can honestly supply. */
const ALLOWED_PARAM_TYPES: ReadonlySet<number> = new Set([
  RouteParamtypes.REQUEST,
  RouteParamtypes.BODY,
  RouteParamtypes.QUERY,
  RouteParamtypes.PARAM,
  RouteParamtypes.HEADERS,
  RouteParamtypes.HOST,
  RouteParamtypes.IP,
]);

function handlerLabel(ref: HandlerRef): string {
  return `${ref.controller?.name ?? '<undefined>'}.${ref.method}`;
}

function guardName(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  if (typeof guard === 'object' && guard !== null)
    return guard.constructor.name;
  return String(guard);
}

/** Validate one binding; returns its route, or null after recording why it is refused. */
function validateBinding(
  ref: HandlerRef,
  where: string,
  problems: string[],
): RouteInfo | null {
  const label = handlerLabel(ref);
  if (typeof ref.controller !== 'function' || !isController(ref.controller)) {
    problems.push(`${where}: ${label} is not a Nest controller`);
    return null;
  }
  const route = readRoute(ref.controller, ref.method);
  if (!route) {
    problems.push(`${where}: ${label} is not a route handler`);
    return null;
  }
  const before = problems.length;
  if (route.isPublic) {
    problems.push(
      `${where}: ${label} is @Public() — a tool always acts as a principal`,
    );
  }
  const badParams = route.paramTypes.filter((t) => !ALLOWED_PARAM_TYPES.has(t));
  if (badParams.length > 0) {
    problems.push(
      `${where}: ${label} takes ${badParams.map((t) => RouteParamtypes[t] ?? t).join(', ')} parameters (response, upload, raw body) the dispatcher cannot supply`,
    );
  }
  if (route.interceptors.length > 0) {
    problems.push(
      `${where}: ${label} uses interceptors (${route.interceptors.map(guardName).join(', ')}) — upload handlers cannot be tools`,
    );
  }
  const badGuards = route.guards.filter(
    (g) => !ALLOWED_HANDLER_GUARDS.includes(g),
  );
  if (badGuards.length > 0) {
    problems.push(
      `${where}: ${label} carries non-allowlisted guards (${badGuards.map(guardName).join(', ')})`,
    );
  }
  if (isExcludedHandler(ref)) {
    problems.push(
      `${where}: ${label} is structurally excluded (returns a credential in cleartext)`,
    );
  }
  const excludedPath = route.paths.find(isExcludedPath);
  if (excludedPath !== undefined) {
    problems.push(
      `${where}: ${label} (/${excludedPath}) is structurally excluded (Secret Manager, credentials or the AI's own configuration)`,
    );
  }
  return problems.length === before ? route : null;
}

function inputJsonSchema(
  tool: AiToolDescriptor,
  problems: string[],
): Record<string, unknown> | null {
  let schema: Record<string, unknown>;
  try {
    schema = z.toJSONSchema(tool.input, {
      io: 'input',
      unrepresentable: 'throw',
    });
  } catch (err) {
    problems.push(
      `tool ${tool.name}: input is not representable as JSON Schema (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
  if (schema.type !== 'object') {
    problems.push(`tool ${tool.name}: input must be an object schema`);
    return null;
  }
  return schema;
}

function channelsFor(
  tool: AiToolDescriptor,
  problems: string[],
): readonly AiChannel[] {
  if (tool.class === 'navigate') {
    const channels = tool.channels ?? ['CHAT'];
    if (channels.some((c) => c !== 'CHAT')) {
      problems.push(`tool ${tool.name}: a navigate tool is chat-only`);
    }
    return channels;
  }
  const channels = tool.channels ?? AI_CHANNELS;
  const unknown = channels.filter((c) => !AI_CHANNELS.includes(c));
  if (unknown.length > 0 || channels.length === 0) {
    problems.push(`tool ${tool.name}: invalid channels ${channels.join(', ')}`);
  }
  return channels;
}

function annotationsFor(tool: AiToolDescriptor): AiToolAnnotations {
  return {
    readOnlyHint: tool.class === 'read' || tool.class === 'navigate',
    destructiveHint: tool.destructive === true || tool.class === 'elevated',
    idempotentHint: tool.idempotent === true,
    openWorldHint: tool.externalEffects === true,
  };
}

/**
 * Validate every toolset and derive the registered tools. Throws {@link AiToolRegistryError} listing
 * every problem found.
 */
export function validateToolsets(
  toolsets: readonly AiToolset[],
): RegisteredAiTool[] {
  const problems: string[] = [];
  const registered: RegisteredAiTool[] = [];
  const names = new Set<string>();
  const bound = new Map<unknown, Set<string>>();

  for (const toolset of toolsets) {
    for (const tool of toolset.tools) {
      const where = `tool ${tool.name}`;
      if (!AI_TOOL_NAME_PATTERN.test(tool.name)) {
        problems.push(
          `${where}: name must match ${AI_TOOL_NAME_PATTERN.source}`,
        );
      }
      if (names.has(tool.name)) {
        problems.push(`${where}: duplicate tool name`);
      }
      names.add(tool.name);
      if (tool.domain !== toolset.domain) {
        problems.push(
          `${where}: declared in the ${toolset.domain} toolset but its domain is ${tool.domain}`,
        );
      }
      if (!tool.title?.trim() || !tool.description?.trim()) {
        problems.push(`${where}: title and description are required`);
      }
      if (!AI_TOOL_CLASSES.includes(tool.class)) {
        problems.push(`${where}: unknown class ${String(tool.class)}`);
      }
      if (
        (tool.class === 'write' || tool.class === 'elevated') &&
        typeof tool.preview !== 'function'
      ) {
        problems.push(`${where}: a ${tool.class} tool must declare a preview`);
      }
      const channels = channelsFor(tool, problems);
      const inputSchema = inputJsonSchema(tool, problems);

      const bindings: readonly HandlerRef[] = Array.isArray(tool.bindings)
        ? tool.bindings
        : [];
      if (bindings.length === 0) {
        problems.push(`${where}: at least one binding is required`);
        continue;
      }
      const routes = bindings.map((ref) =>
        validateBinding(ref, where, problems),
      );
      for (const ref of bindings) {
        const methods = bound.get(ref.controller) ?? new Set<string>();
        methods.add(ref.method);
        bound.set(ref.controller, methods);
      }
      const primary = routes[0];
      if (!primary || !inputSchema || routes.some((r) => r === null)) {
        continue;
      }

      const guards = primary.guards;
      const humanOnly =
        guards.includes(ServicePrincipalForbiddenGuard) ||
        guards.includes(HumanOnlyGuard);
      const serviceOnly = guards.includes(ServiceOnlyGuard);
      registered.push({
        descriptor: tool,
        inputSchema,
        schemaHash: createHash('sha256')
          .update(JSON.stringify(inputSchema))
          .digest('hex'),
        permissions: primary.permissions,
        principalKinds: {
          human: !serviceOnly,
          // RolesGuard is fail-closed for a Service Account on a route with no permission gate (INV-SA-2).
          service: !humanOnly && primary.permissions.length > 0,
        },
        channels,
        annotations: annotationsFor(tool),
        route: { method: primary.httpMethod, path: `/${primary.paths[0]}` },
      });
    }
  }

  const unexposedSeen = new Map<unknown, Set<string>>();
  for (const toolset of toolsets) {
    for (const entry of toolset.unexposed) {
      const where = `${toolset.domain} unexposed`;
      if (
        typeof entry.controller !== 'function' ||
        !isController(entry.controller)
      ) {
        problems.push(
          `${where}: ${entry.controller?.name ?? '<undefined>'} is not a Nest controller`,
        );
        continue;
      }
      if (!entry.reason?.trim()) {
        problems.push(`${where}: ${entry.controller.name} needs a reason`);
      }
      const seen = unexposedSeen.get(entry.controller) ?? new Set<string>();
      unexposedSeen.set(entry.controller, seen);
      for (const method of entry.methods) {
        const label = `${entry.controller.name}.${method}`;
        if (!readRoute(entry.controller, method)) {
          problems.push(`${where}: ${label} is not a route handler`);
        }
        if (seen.has(method)) {
          problems.push(`${where}: ${label} is listed twice`);
        }
        seen.add(method);
        if (bound.get(entry.controller)?.has(method)) {
          problems.push(
            `${where}: ${label} is bound by a tool and listed as unexposed`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new AiToolRegistryError(problems);
  }
  return registered;
}

/** Every handler a toolset decided on — bound by a tool or listed as unexposed. For the coverage test. */
export function decidedHandlers(
  toolsets: readonly AiToolset[],
): Map<unknown, Set<string>> {
  const decided = new Map<unknown, Set<string>>();
  const add = (controller: unknown, method: string) => {
    const methods = decided.get(controller) ?? new Set<string>();
    methods.add(method);
    decided.set(controller, methods);
  };
  for (const toolset of toolsets) {
    for (const tool of toolset.tools) {
      for (const ref of tool.bindings) add(ref.controller, ref.method);
    }
    for (const entry of toolset.unexposed) {
      for (const method of entry.methods) add(entry.controller, method);
    }
  }
  return decided;
}
