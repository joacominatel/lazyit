import { Injectable } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/internal';
import {
  ExternalContextCreator,
  ModulesContainer,
  type ParamsFactory,
} from '@nestjs/core';
import {
  attachDelegatedIdentity,
  type DelegatedIdentity,
} from '../../auth/delegated-identity';
import type { HandlerRef, HttpShape } from './tool-descriptor';

type WrappedHandler = (...args: unknown[]) => Promise<unknown>;

/** The request object a tool call runs with. Only string-keyed, JSON-shaped data plus the delegated identity. */
export interface SyntheticRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  hosts: Record<string, string>;
  ip: undefined;
}

type ParamExtractor = (
  req: SyntheticRequest,
  key: string | undefined,
) => unknown;

/**
 * How each built-in parameter decorator reads the synthetic request, like Nest's own
 * `RouteParamsFactory` does for an Express request. Response, upload, raw-body and session parameters
 * are absent: they are refused at boot (`boot-validation.ts`), so reaching one here is a bug.
 */
const PARAM_EXTRACTORS = new Map<number, ParamExtractor>([
  [RouteParamtypes.REQUEST, (req) => req],
  [
    RouteParamtypes.BODY,
    (req, key) =>
      key && req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)[key]
        : req.body,
  ],
  [RouteParamtypes.QUERY, (req, key) => (key ? req.query[key] : req.query)],
  [RouteParamtypes.PARAM, (req, key) => (key ? req.params[key] : req.params)],
  [
    RouteParamtypes.HEADERS,
    (req, key) => (key ? req.headers[key.toLowerCase()] : req.headers),
  ],
  [RouteParamtypes.HOST, (req, key) => (key ? req.hosts[key] : req.hosts)],
  [RouteParamtypes.IP, (req) => req.ip],
]);

const SYNTHETIC_PARAMS_FACTORY: ParamsFactory = {
  exchangeKeyForValue(type: number, data: unknown, args: unknown): unknown {
    const extract = PARAM_EXTRACTORS.get(type);
    if (!extract) {
      throw new Error(
        `AI tool dispatch: parameter type ${type} cannot be supplied in-process`,
      );
    }
    const [req] = args as [SyntheticRequest];
    const key = typeof data === 'string' && data.length > 0 ? data : undefined;
    return extract(req, key);
  },
};

const SYNTHETIC_RESPONSE = Object.freeze({});
const NOOP_NEXT = () => undefined;

/**
 * THE C3 BRIDGE (ADR-0097, R1; tools-and-execution.md §5 Fork C3). Runs a controller handler in-process
 * through Nest's own pipeline — the global guards (`JwtAuthGuard` → `MustChangePasswordGuard` →
 * `RolesGuard`), the class and handler guards, the global `ZodValidationPipe` and the param pipes, then
 * the controller logic and every service-level check behind it — with a synthetic request that carries
 * the invoking principal as a delegated identity. A tool therefore gets exactly the outcome the route
 * would give that principal; there is no second authorization path to drift.
 *
 * Exception filters are OFF: an exception reaches the executor unchanged and becomes a tool error.
 *
 * NestJS 12 caveat, handled here: `ExternalContextCreator` finds the handler's host module by scanning
 * module PROVIDERS. A controller is not a provider, so it would fall back to no module and SILENTLY DROP
 * every guard and pipe referenced by class (`@UseGuards(ServicePrincipalForbiddenGuard)`,
 * `@Param('id', ParseUUIDPipe)`) — they are resolved from the host module's injectables. The dispatcher
 * therefore finds the controller's module itself and pins that key. The route-parity spec proves the
 * class-referenced guards and pipes run.
 */
@Injectable()
export class AiToolDispatcher {
  private readonly handlers = new Map<unknown, Map<string, WrappedHandler>>();

  constructor(
    private readonly externalContextCreator: ExternalContextCreator,
    private readonly modules: ModulesContainer,
  ) {}

  /** Run `ref` as `identity` with the given params, query and body; resolves to the handler's result. */
  async dispatch(
    ref: HandlerRef,
    identity: DelegatedIdentity,
    shape: HttpShape = {},
  ): Promise<unknown> {
    const handler = this.resolve(ref);
    const request = createSyntheticRequest(identity, shape);
    return handler(request, SYNTHETIC_RESPONSE, NOOP_NEXT);
  }

  /**
   * The Nest-wrapped handler for `ref`, built once. Throws when the controller is not registered in the
   * application or is request-scoped (the dispatcher only runs static controllers).
   */
  resolve(ref: HandlerRef): WrappedHandler {
    const cached = this.handlers.get(ref.controller)?.get(ref.method);
    if (cached) return cached;

    const label = `${ref.controller.name}.${ref.method}`;
    for (const [moduleKey, moduleRef] of this.modules) {
      const wrapper = moduleRef.controllers.get(ref.controller);
      if (!wrapper) continue;
      if (!wrapper.isDependencyTreeStatic()) {
        throw new Error(
          `AI tool dispatch: ${label} is request-scoped; only static controllers can be tools`,
        );
      }
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      const callback = instance?.[ref.method];
      if (!instance || typeof callback !== 'function') {
        throw new Error(`AI tool dispatch: ${label} is not a handler`);
      }
      // Pin the host module (see the class comment): an own `getContextModuleKey` shadows the prototype's.
      const creator = Object.create(this.externalContextCreator, {
        getContextModuleKey: { value: () => moduleKey },
      }) as ExternalContextCreator;
      const handler = creator.create(
        instance,
        callback as (...args: unknown[]) => unknown,
        ref.method,
        ROUTE_ARGS_METADATA,
        SYNTHETIC_PARAMS_FACTORY,
        undefined,
        undefined,
        { guards: true, interceptors: true, filters: false },
        'http',
      ) as WrappedHandler;
      const byMethod =
        this.handlers.get(ref.controller) ?? new Map<string, WrappedHandler>();
      byMethod.set(ref.method, handler);
      this.handlers.set(ref.controller, byMethod);
      return handler;
    }
    throw new Error(
      `AI tool dispatch: ${label} is not registered in any module of this application`,
    );
  }
}

/**
 * Build the synthetic request. The body is round-tripped through JSON so a handler receives exactly what
 * a network client could have sent — no Dates, prototypes or symbols ride along. Undefined query values
 * are dropped, as an absent query-string parameter would be.
 */
export function createSyntheticRequest(
  identity: DelegatedIdentity,
  shape: HttpShape,
): SyntheticRequest {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape.query ?? {})) {
    if (value !== undefined) query[key] = value;
  }
  const request: SyntheticRequest = {
    method: 'AI-TOOL',
    url: '',
    params: { ...(shape.params ?? {}) },
    query,
    body:
      shape.body === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(shape.body)) as unknown),
    headers: {},
    hosts: {},
    ip: undefined,
  };
  attachDelegatedIdentity(request, identity);
  return request;
}
