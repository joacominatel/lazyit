import type { Type } from '@nestjs/common';
import type { z } from 'zod';
import type {
  AiActionPreview,
  AiChannel,
  AiEntityRef,
  AiSentence,
  AiToolAnnotations,
  AiToolClass,
  AiTruncation,
  Permission,
} from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import type {
  AiReferenceSpec,
  AiResolvedReference,
} from './reference-resolver';

/**
 * The AI tool registry's internal types (ADR-0097; docs/ai-assistant/_synthesis.md §4.1–§4.3, R4;
 * tools-and-execution.md §8 and §16). The wire side — classes, results, entity refs, previews — lives in
 * `@lazyit/shared` (`ai-tools.ts`).
 */

/** The per-domain files under `ai/tools/`. `platform` holds the surfaces no domain toolset owns. */
export type AiToolDomain =
  | 'context'
  | 'assets'
  | 'reference'
  | 'access'
  | 'consumables'
  | 'kb'
  | 'users'
  | 'activity'
  | 'infra'
  | 'platform'
  | 'interaction';

/** One controller handler: the class and the method name of a Nest route. */
export interface HandlerRef {
  readonly controller: Type<unknown>;
  readonly method: string;
}

/** Name a controller handler with a compile-time check that the method exists. */
export function bind<C>(
  controller: Type<C>,
  method: keyof C & string,
): HandlerRef {
  return { controller, method };
}

/** What a tool passes to a handler — the parts of an HTTP request a controller reads. */
export interface HttpShape {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
}

/**
 * Who is calling and through which channel. The identity is ids only: the principal is re-loaded from
 * the database on every call (by the tool service's gate check and again by `JwtAuthGuard`), never
 * carried as a loaded row.
 */
export interface AiExecutionContext {
  identity: DelegatedIdentity;
  channel: AiChannel;
  conversationId?: string;
  runId?: string;
  /** MCP only: the grant and client the call came through. */
  mcp?: { grantId: string; clientId: string };
  /**
   * The class CEILING, when one applies: the MCP token's scopes (R7) or the Service Account's AI access
   * setting (headless). Absent = no ceiling beyond the principal's own permissions.
   */
  ceiling?: readonly AiToolClass[];
  /**
   * What the ledger records about the model call that produced this tool call (security.md §6.7): the
   * provider and model the run used, and the request id. Supplied by the runtime or `/mcp`; optional.
   */
  provenance?: { provider?: string; model?: string; requestId?: string };
  /**
   * Chat only: the other-authored content the turn had read before this call (the untrusted-source
   * banner). `propose` merges it into the stored preview; the ledger records it.
   */
  untrustedSources?: readonly AiEntityRef[];
}

type HandlerResult<C, M extends keyof C> = C[M] extends (
  ...args: never[]
) => infer R
  ? Awaited<R>
  : never;

/**
 * What a tool's `run` and `preview` receive. `call` is the ONLY way a tool reaches the domain: it runs a
 * handler listed in the tool's `bindings` through Nest's own guards, pipes and controller logic, as the
 * invoking principal. A handler outside `bindings` is refused.
 */
export interface AiToolRuntime {
  readonly ctx: Readonly<AiExecutionContext & { invocationId: string }>;
  call<C, M extends keyof C & string>(
    controller: Type<C>,
    method: M,
    shape?: HttpShape,
  ): Promise<HandlerResult<C, M>>;
  /**
   * Resolve a human-readable reference (id, tag, serial, email, slug, exact name) to exactly one entity
   * (`reference-resolver.ts`). The spec's `lookup` must read through `call`, so the resolution is
   * authorized like the route. Throws a tool error (`NOT_FOUND`, `AMBIGUOUS_REFERENCE`) otherwise.
   */
  resolve(spec: AiReferenceSpec): Promise<AiResolvedReference>;
}

/** What `run` returns; the executor wraps it into an `AiToolResult`. */
export interface AiToolRunOutput<D = unknown> {
  data: D;
  summary?: string;
  /** `summary` as localizable sentences (#1384) — build both with `summaryPhrase` (`core/sentences.ts`). */
  summarySentences?: AiSentence[];
  entityRefs?: AiEntityRef[];
  truncated?: AiTruncation;
}

/** What `preview` returns; the executor adds `toolName` and `class`. */
export type AiToolPreview = Omit<AiActionPreview, 'toolName' | 'class'>;

/**
 * One tool (R4). The permission is NOT declared here: it is derived at boot from the primary binding's
 * `@RequirePermission`, so it cannot drift from the route.
 */
export interface AiToolDescriptor<
  S extends z.ZodType = z.ZodType,
  D = unknown,
> {
  /** `^[a-z][a-z0-9_]{0,39}$`, unique across the catalog. */
  name: string;
  title: string;
  description: string;
  domain: AiToolDomain;
  class: AiToolClass;
  /** Overwrites or removes existing state (MCP `destructiveHint`). */
  destructive?: boolean;
  /** May trigger external provisioning or notifications (MCP `openWorldHint`). */
  externalEffects?: boolean;
  idempotent?: boolean;
  /** Default: every channel; a `navigate` tool is chat-only. */
  channels?: readonly AiChannel[];
  /**
   * An interaction tool (#1388, `request_input`): its `run` only validates and builds a form; the chat
   * runtime then pauses the run `AWAITING_INPUT` and answers the call with the user's submission. Only a
   * `navigate` (chat-only) tool may set it.
   */
  awaitsInput?: boolean;
  /** Validated by the executor before any dispatch; its JSON Schema (`io: "input"`) is what channels list. */
  input: S;
  /**
   * Optional tolerance applied to the raw model input BEFORE `input` validates it (#1403): a pure,
   * deterministic rewrite of harmless noise (a `null` or empty value meaning "absent", a property that does
   * not apply). It never widens what the tool accepts semantically and never touches the listed schema.
   */
  normalizeInput?(raw: unknown): unknown;
  /**
   * How many changes one call of a `write`/`elevated` tool counts for against the per-Service-Account
   * mutation cap (SEC-081; `core/mutation-weight.ts`) — the records it writes, from the validated input
   * (a batch: its rows). Default 1. Values below 1 count as 1.
   */
  mutationWeight?(input: z.output<S>): number;
  /** The handlers `run`/`preview` may call. `[0]` is primary: its `@RequirePermission` is the tool's. */
  bindings: readonly [HandlerRef, ...HandlerRef[]];
  run(input: z.output<S>, rt: AiToolRuntime): Promise<AiToolRunOutput<D>>;
  /** Mandatory for `write` and `elevated`: the server-built preview, never model prose. */
  preview?(input: z.output<S>, rt: AiToolRuntime): Promise<AiToolPreview>;
}

/** Declare a tool with its input type inferred from its schema. */
export function defineTool<S extends z.ZodType, D>(
  descriptor: AiToolDescriptor<S, D>,
): AiToolDescriptor<S, D> {
  return descriptor;
}

/**
 * Handlers a domain deliberately does not expose, with the reason. Every controller handler must be
 * bound by a tool or listed here — the coverage test forces a decision for every new endpoint.
 */
export interface UnexposedHandlers {
  readonly controller: Type<unknown>;
  readonly methods: readonly string[];
  readonly reason: string;
}

/** List handlers of one controller as unexposed, with a compile-time check on the method names. */
export function unexposed<C>(
  controller: Type<C>,
  methods: readonly (keyof C & string)[],
  reason: string,
): UnexposedHandlers {
  return { controller, methods, reason };
}

/** What each `ai/tools/<domain>.tools.ts` exports. */
export interface AiToolset {
  readonly domain: AiToolDomain;
  readonly tools: readonly AiToolDescriptor[];
  readonly unexposed: readonly UnexposedHandlers[];
}

/** A tool after boot validation, with everything derived from its route. */
export interface RegisteredAiTool {
  readonly descriptor: AiToolDescriptor;
  /** JSON Schema (draft 2020-12) of the input, `io: "input"`. */
  readonly inputSchema: Record<string, unknown>;
  /** SHA-256 of the input schema — a changed tool expires a pending approval. */
  readonly schemaHash: string;
  /**
   * The primary route's `@RequirePermission` (AND semantics). Empty = the route has no permission gate:
   * any authenticated human passes and a Service Account is refused (INV-8, INV-SA-2).
   */
  readonly permissions: readonly Permission[];
  /** Which principal kinds the primary route's guards admit at all. */
  readonly principalKinds: {
    readonly human: boolean;
    readonly service: boolean;
  };
  readonly channels: readonly AiChannel[];
  readonly annotations: AiToolAnnotations;
  /** The primary route, for diagnostics and the parity golden. */
  readonly route: { readonly method: string; readonly path: string };
}

/**
 * What a channel lists. API-internal: `permissions` is a list because a route may require several
 * permissions, or none (see {@link RegisteredAiTool.permissions}).
 */
export interface AiToolListing {
  name: string;
  title: string;
  description: string;
  class: AiToolClass;
  inputSchema: Record<string, unknown>;
  permissions: readonly Permission[];
  annotations: AiToolAnnotations;
}
