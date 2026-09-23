import { z } from "zod";
import { PermissionSchema } from "./permission";
import { int4 } from "./primitives";

/**
 * The AI tool contract (ADR-0097 decisions 3 and 6; docs/ai-assistant/_synthesis.md §4.1 and §4.3,
 * reconciliations R3 and R4; tools-and-execution.md §16). One tool catalog serves three channels. The
 * registry itself is API-internal (`apps/api/src/ai/core/`); this file is its WIRE side: the channel and
 * class vocabularies, the manifest a channel lists, the tool result, the entity refs the web turns into
 * links, and the server-built approval preview.
 *
 * Vocabulary casing follows the synthesis: channels are upper-case (they are stored as-is in the text
 * columns of `ai_*` tables), tool classes, call kinds and entity ops are lower-case.
 */

/** The three channels (synthesis §1). Stored verbatim in `channel` text columns. */
export const AI_CHANNELS = ["CHAT", "MCP", "HEADLESS"] as const;
export const AiChannelSchema = z.enum(AI_CHANNELS);
export type AiChannel = z.infer<typeof AiChannelSchema>;

/**
 * Tool classes (R4). The class drives the confirmation card, the MCP annotations, the OAuth scope a tool
 * needs and the headless ceiling:
 *   - `read`     — reads; runs freely.
 *   - `write`    — ordinary and destructive writes; a standard preview card in the chat.
 *   - `elevated` — privilege, identity, credential delivery, configuration; the elevated card.
 *   - `navigate` — chat-only navigation; never listed over MCP.
 */
export const AI_TOOL_CLASSES = ["read", "write", "elevated", "navigate"] as const;
export const AiToolClassSchema = z.enum(AI_TOOL_CLASSES);
export type AiToolClass = z.infer<typeof AiToolClassSchema>;

/** The kind of a finished call (R3) — what the web does with its result. */
export const AI_CALL_KINDS = ["read", "mutation", "navigate"] as const;
export const AiCallKindSchema = z.enum(AI_CALL_KINDS);
export type AiCallKind = z.infer<typeof AiCallKindSchema>;

/**
 * Tool names (R4): lower-case snake case, starting with a letter, at most 40 characters — within every
 * provider's and MCP client's naming rules.
 */
export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const AiToolNameSchema = z
  .string()
  .regex(AI_TOOL_NAME_PATTERN, "Tool names are lower-case snake case, 1–40 characters");
export type AiToolName = z.infer<typeof AiToolNameSchema>;

/**
 * The entity types a tool result may reference (tools-and-execution.md §16). The web maps each type it
 * knows to a route; the API never sends an href (R3).
 */
export const AI_ENTITY_TYPES = [
  "asset",
  "assetAssignment",
  "assetModel",
  "location",
  "category",
  "application",
  "accessGrant",
  "accessRequest",
  "consumable",
  "consumableMovement",
  "article",
  "user",
  "infraNode",
  "infraEdge",
  "workflowRun",
  "manualTask",
] as const;
export const AiEntityTypeSchema = z.enum(AI_ENTITY_TYPES);
export type AiEntityType = z.infer<typeof AiEntityTypeSchema>;

/** What happened to a referenced entity (R3). `navigate` marks the target of a navigate tool. */
export const AI_ENTITY_OPS = ["created", "updated", "archived", "restored", "navigate"] as const;
export const AiEntityOpSchema = z.enum(AI_ENTITY_OPS);
export type AiEntityOp = z.infer<typeof AiEntityOpSchema>;

const EntityPointerSchema = z.object({
  type: AiEntityTypeSchema,
  id: z.string().min(1),
  slug: z.string().min(1).optional(),
});

/**
 * A semantic entity reference `{ type, id, op, label?, slug?, parent? }`. `parent` points at the page an
 * entity without its own page lives on (an assignment → its asset, a grant → its application, a
 * movement → its consumable).
 */
export const AiEntityRefSchema = EntityPointerSchema.extend({
  op: AiEntityOpSchema,
  label: z.string().optional(),
  parent: EntityPointerSchema.optional(),
});
export type AiEntityRef = z.infer<typeof AiEntityRefSchema>;

/**
 * The READ-TOLERANT list of entity refs used inside every read shape: each item is parsed on its own and
 * an item this build does not understand (a newer entity type, a newer op) is dropped instead of failing
 * the whole event or result. An older web keeps working against a newer API.
 */
export const AiEntityRefListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = AiEntityRefSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/**
 * Tool-level error codes (tools-and-execution.md §16). A precondition mismatch at approve time is
 * `STALE`; an execution whose outcome is unknown after a crash is `UNKNOWN_OUTCOME` and is never retried.
 */
export const AI_TOOL_ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "AMBIGUOUS_REFERENCE",
  "FORBIDDEN",
  "CONFLICT",
  "STALE",
  "EXPIRED",
  "NOT_AVAILABLE",
  "RATE_LIMITED",
  "UNKNOWN_OUTCOME",
  "INTERNAL",
] as const;
export const AiToolErrorCodeSchema = z.enum(AI_TOOL_ERROR_CODES);
export type AiToolErrorCode = z.infer<typeof AiToolErrorCodeSchema>;

/** Marks a truncated list result: what was shown, the total when known, and where to continue. */
export const AiTruncationSchema = z.object({
  shown: int4({ min: 0 }),
  total: int4({ min: 0 }).optional(),
  nextOffset: int4({ min: 0 }).optional(),
});
export type AiTruncation = z.infer<typeof AiTruncationSchema>;

/**
 * The result of one tool call (synthesis §4.3), discriminated on `ok`. A failed call never mutated
 * anything. Results are truncated once, at write time.
 */
export const AiToolResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    kind: AiCallKindSchema,
    data: z.unknown(),
    summary: z.string().optional(),
    mutated: z.boolean(),
    truncated: AiTruncationSchema.optional(),
    entityRefs: AiEntityRefListSchema,
  }),
  z.object({
    ok: z.literal(false),
    kind: AiCallKindSchema,
    error: z.object({
      code: AiToolErrorCodeSchema,
      status: int4({ min: 100, max: 599 }).optional(),
      message: z.string(),
      hint: z.string().optional(),
    }),
    mutated: z.literal(false),
    entityRefs: AiEntityRefListSchema.default([]),
  }),
]);
export type AiToolResult = z.infer<typeof AiToolResultSchema>;

/**
 * The warning codes a server-built preview may carry (synthesis §4.3). The web localizes each code it
 * knows and renders an unknown one generically, so the preview's `warnings` stay open strings.
 */
export const AI_PREVIEW_WARNING_CODES = [
  "EXTERNAL_PROVISIONING",
  "EXTERNAL_DEPROVISIONING",
  "CASCADE_RELEASES_ASSIGNMENTS",
  "CASCADE_REVOKES_GRANTS",
  "ROLE_CHANGE",
  "IDENTITY_CHANGE",
  "LEDGER_APPEND",
  "SOFT_DELETE",
  "PUBLISHES_TO_READERS",
  "VISIBILITY_CHANGE",
  "NOTIFIES_USERS",
  "IRREVERSIBLE",
] as const;
export const AiPreviewWarningCodeSchema = z.enum(AI_PREVIEW_WARNING_CODES);
export type AiPreviewWarningCode = z.infer<typeof AiPreviewWarningCodeSchema>;

/** How the web renders a changed value on the preview card. */
export const AI_PREVIEW_VALUE_KINDS = [
  "text",
  "number",
  "date",
  "entity",
  "boolean",
  "redacted",
] as const;
export const AiPreviewValueKindSchema = z.enum(AI_PREVIEW_VALUE_KINDS);
export type AiPreviewValueKind = z.infer<typeof AiPreviewValueKindSchema>;

/**
 * The server-built preview of a proposed write (synthesis §4.3). Nothing in it comes from model prose.
 * `elevated` is the tool's class or an escalation the preview decided; `precondition` is checked at
 * execute so the approved action runs against the version the user saw.
 */
export const AiActionPreviewSchema = z.object({
  toolName: AiToolNameSchema,
  class: z.enum(["write", "elevated"]),
  target: AiEntityRefSchema.optional(),
  changes: z.array(
    z.object({
      field: z.string().min(1),
      before: z.unknown().optional(),
      after: z.unknown(),
      valueKind: AiPreviewValueKindSchema.optional(),
    }),
  ),
  warnings: z.array(z.string()),
  impacted: z
    .array(
      z.object({
        type: AiEntityTypeSchema,
        count: int4({ min: 0 }),
        sample: AiEntityRefListSchema.pipe(z.array(AiEntityRefSchema).max(5)),
      }),
    )
    .default([]),
  untrustedSources: AiEntityRefListSchema.default([]),
  elevated: z.boolean(),
  stepUpRequired: z.boolean(),
  precondition: z
    .object({
      entity: AiEntityRefSchema,
      updatedAt: z.iso.datetime(),
    })
    .optional(),
});
export type AiActionPreview = z.infer<typeof AiActionPreviewSchema>;

/** MCP tool annotations, derived from the class (R4) — never hand-declared per tool. */
export const AiToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean(),
  destructiveHint: z.boolean(),
  idempotentHint: z.boolean(),
  openWorldHint: z.boolean(),
});
export type AiToolAnnotations = z.infer<typeof AiToolAnnotationsSchema>;

/**
 * The tool descriptor's wire shape — what a channel lists (tools-and-execution.md §16
 * `AiToolManifest`). `permission` is derived at boot from the primary route's `@RequirePermission`,
 * never hand-declared; `inputSchema` is the JSON Schema of the tool's zod input (`io: "input"`).
 */
export const AiToolManifestSchema = z.object({
  name: AiToolNameSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  class: AiToolClassSchema,
  permission: PermissionSchema,
  annotations: AiToolAnnotationsSchema,
});
export type AiToolManifest = z.infer<typeof AiToolManifestSchema>;
