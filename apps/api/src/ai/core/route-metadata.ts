import { RequestMethod, type Type } from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { Permission } from '@lazyit/shared';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator';
import { PERMISSION_KEY } from '../../auth/require-permission.decorator';

/**
 * Reads the decorator metadata Nest itself routes and guards by, so the AI registry derives a tool's
 * permission, guards and parameter kinds from the route instead of a hand-written declaration (R4).
 * Nothing here instantiates anything.
 */

/** Everything the registry needs to know about one controller handler. */
export interface RouteInfo {
  readonly httpMethod: string;
  /** Every path the handler answers on, normalized without leading or trailing slashes. */
  readonly paths: readonly string[];
  readonly isPublic: boolean;
  /** `@RequirePermission` with Reflector `getAllAndOverride` semantics (the handler overrides the class). */
  readonly permissions: readonly Permission[];
  /** Class-level then handler-level `@UseGuards` entries (classes or instances). */
  readonly guards: readonly unknown[];
  readonly interceptors: readonly unknown[];
  /** The `RouteParamtypes` of the handler's built-in parameter decorators (custom decorators excluded). */
  readonly paramTypes: readonly number[];
}

function handlerFunction(
  controller: Type<unknown>,
  method: string,
): ((...args: unknown[]) => unknown) | undefined {
  const candidate: unknown = (
    controller.prototype as Record<string, unknown> | undefined
  )?.[method];
  return typeof candidate === 'function'
    ? (candidate as (...args: unknown[]) => unknown)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

function normalizePath(...segments: string[]): string {
  return segments
    .join('/')
    .split('/')
    .filter((part) => part.length > 0)
    .join('/');
}

/** Whether the class is a Nest controller (`@Controller`). */
export function isController(controller: Type<unknown>): boolean {
  return Reflect.hasMetadata(PATH_METADATA, controller);
}

/** The route handler methods of a controller, in prototype order (inherited handlers included). */
export function listRouteHandlers(controller: Type<unknown>): string[] {
  const methods: string[] = [];
  const seen = new Set<string>();
  let proto: object | null = controller.prototype as object;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      if (readRoute(controller, name)) methods.push(name);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return methods;
}

/** The route metadata of a handler, or null when the method is not a route handler. */
export function readRoute(
  controller: Type<unknown>,
  method: string,
): RouteInfo | null {
  const handler = handlerFunction(controller, method);
  if (!handler) return null;
  const requestMethod: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
  if (typeof requestMethod !== 'number') return null;

  const controllerPaths = asArray(
    Reflect.getMetadata(PATH_METADATA, controller),
  ).map(String);
  const handlerPaths = asArray(Reflect.getMetadata(PATH_METADATA, handler)).map(
    String,
  );
  const paths: string[] = [];
  for (const base of controllerPaths.length ? controllerPaths : ['']) {
    for (const sub of handlerPaths.length ? handlerPaths : ['']) {
      paths.push(normalizePath(base, sub));
    }
  }

  const handlerPublic: unknown = Reflect.getMetadata(IS_PUBLIC_KEY, handler);
  const classPublic: unknown = Reflect.getMetadata(IS_PUBLIC_KEY, controller);
  const handlerPerms: unknown = Reflect.getMetadata(PERMISSION_KEY, handler);
  const classPerms: unknown = Reflect.getMetadata(PERMISSION_KEY, controller);
  const permissions = (
    handlerPerms !== undefined ? handlerPerms : classPerms
  ) as Permission[] | undefined;

  const routeArgs = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    method,
  ) ?? {}) as Record<string, unknown>;
  const paramTypes = Object.keys(routeArgs)
    .filter((key) => !key.includes(CUSTOM_ROUTE_ARGS_METADATA))
    .map((key) => Number(key.split(':')[0]));

  return {
    httpMethod: RequestMethod[requestMethod] ?? String(requestMethod),
    paths,
    isPublic: (handlerPublic ?? classPublic) === true,
    permissions: permissions ?? [],
    guards: [
      ...asArray(Reflect.getMetadata(GUARDS_METADATA, controller)),
      ...asArray(Reflect.getMetadata(GUARDS_METADATA, handler)),
    ],
    interceptors: [
      ...asArray(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)),
      ...asArray(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)),
    ],
    paramTypes,
  };
}
