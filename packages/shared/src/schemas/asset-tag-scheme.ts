import { z } from "zod";
import { int4 } from "./primitives";

/**
 * AssetTagScheme — lazyit's first instance-config entity (ADR-0063, #363): the org-wide,
 * single-row, opt-in scheme that auto-assigns a running asset tag on create. Single source of
 * truth for api and web.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` cannot be represented in JSON Schema / OpenAPI ([[0018]]).
 *
 * The MANDATORY `{num}` running number — modelling choice (ADR-0063 §1/§2): rather than a free-text
 * `template` string whose `{num}` token must be regex-validated and re-parsed, the scheme uses
 * EXPLICIT FIELDS — `prefix` + a zero-padded sequence + `suffix`. The running number is therefore
 * STRUCTURALLY ALWAYS PRESENT: every rendered tag is `prefix + zeroPad(num, width) + suffix`, so a
 * scheme without the sequence is simply unrepresentable (there is no field to omit). This is the
 * cleaner of the two options the ADR offers and maps 1:1 to the Prisma columns. `prefix`/`suffix`
 * are optional free text; `width` is an optional zero-pad.
 *
 * Bounds (ADR-0036, int4): `nextNumber`/`startNumber` are int4-bounded non-negative integers (the
 * counter is a Postgres `Int`); `width` is a small non-negative pad. Free-text affixes are trimmed
 * and bounded so a rendered tag stays within the 200-char `Asset.assetTag` column.
 */

/** Max characters for the prefix/suffix free text (well under the 200-char assetTag column). */
export const ASSET_TAG_AFFIX_MAX = 64;
/** Max zero-pad width — a tag like `LAZY-` + 32 digits is already absurd; cap it sanely. */
export const ASSET_TAG_WIDTH_MAX = 32;

/** Optional, trimmed, bounded affix (prefix/suffix). Absent when omitted (no empty-string affix). */
const affix = () => z.string().trim().min(1).max(ASSET_TAG_AFFIX_MAX).optional();

/**
 * Render a tag from a scheme + an allocated sequence number: `prefix + zeroPad(num, width) + suffix`.
 * Pure and framework-agnostic so api (allocation) and web (live preview) render IDENTICALLY. `width`
 * left-pads the number with zeros to at least that many digits; a number already wider is unchanged.
 */
export function renderAssetTag(
  scheme: { prefix?: string | null; suffix?: string | null; width?: number | null },
  num: number,
): string {
  const body =
    scheme.width && scheme.width > 0
      ? String(num).padStart(scheme.width, "0")
      : String(num);
  return `${scheme.prefix ?? ""}${body}${scheme.suffix ?? ""}`;
}

/**
 * `GET /config/asset-tag-scheme` — the persisted scheme (or its explicit unset/disabled state).
 * `enabled` + `nextNumber` are the load-bearing fields: when no scheme has ever been configured the
 * API returns `enabled: false` with the defaults, so the frontend always has a concrete shape to
 * render (never a 404 for "unset"). `nextNumber` is the NEXT value that would be allocated.
 */
/**
 * Parse the numeric body out of a tag given a scheme's affixes (ADR-0068 §1/§2). A tag MATCHES the
 * scheme when it (a) starts with `prefix`, (b) ends with `suffix`, and (c) the middle is non-empty
 * and ALL digits — then the parsed integer is returned. Anything else (wrong affix, empty/non-numeric
 * middle, a number that overflows) returns `null` (the tag does not conform). `width` is NOT enforced
 * here: a zero-padded body and a wider body are both valid (padding is presentational), matching the
 * "editing the template does not rewrite issued tags" rule — only the prefix/suffix/digits shape
 * decides. NOTE on overlapping affixes: when `prefix.length + suffix.length` exceeds the tag length the
 * slice would be negative/empty, so the digits check below rejects it — a tag must carry a real body.
 *
 * Pure and framework-agnostic so api (seed parsing + the normalize-non-conforming selection) and web
 * (any client-side hinting) agree on EXACTLY what "conforms" means.
 */
export function parseAssetTagNumber(
  scheme: { prefix?: string | null; suffix?: string | null },
  tag: string,
): number | null {
  const prefix = scheme.prefix ?? "";
  const suffix = scheme.suffix ?? "";
  if (!tag.startsWith(prefix) || !tag.endsWith(suffix)) return null;
  // The body sits between the affixes; guard against affixes that overlap (longer than the tag).
  const bodyEnd = tag.length - suffix.length;
  if (bodyEnd <= prefix.length) return null;
  const body = tag.slice(prefix.length, bodyEnd);
  if (!/^[0-9]+$/.test(body)) return null;
  const num = Number(body);
  return Number.isSafeInteger(num) ? num : null;
}

export const AssetTagSchemeSchema = z.object({
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
  /** Zero-pad width (`null`/`0` = no padding). */
  width: z.number().int().nullable(),
  /** The next sequence value to allocate (monotonic; gaps accepted — ADR-0063 §3). */
  nextNumber: z.number().int(),
  /** OFF by default (ADR-0063 §4): false = no auto-tag, the create path is unchanged. */
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * `PUT /config/asset-tag-scheme` body — upsert the single config row (ADR-0063 §4). `enabled` is
 * required (turning the scheme on/off is the deliberate config act). `prefix`/`suffix`/`width` shape
 * the template; `startNumber` OPTIONALLY (re)seeds the counter — when present the next allocation
 * starts there (e.g. begin the sequence at 1000). The `{num}` running number is structural (see the
 * file header), so a config without a sequence is unrepresentable here — there is no way to express
 * one, which is exactly how the ADR's "reject a scheme without `{num}`" rule is satisfied.
 */
export const UpdateAssetTagSchemeSchema = z.strictObject({
  enabled: z.boolean(),
  prefix: affix(),
  suffix: affix(),
  width: int4({ min: 0, max: ASSET_TAG_WIDTH_MAX, example: 5 }).optional(),
  /**
   * Optional starting number for the counter (the NEXT value allocated). Omit to leave the counter
   * untouched (so toggling `enabled` does not rewind the sequence — ADR-0063 §1/§4). When the row is
   * first created and `startNumber` is omitted, the counter defaults to 1.
   */
  startNumber: int4({ min: 0, example: 1 }).optional(),
});

export type AssetTagScheme = z.infer<typeof AssetTagSchemeSchema>;
export type UpdateAssetTagScheme = z.infer<typeof UpdateAssetTagSchemeSchema>;

/* -------------------------------------------------------------------------- */
/* Truthful next-tag preview (#1180)                                           */
/* -------------------------------------------------------------------------- */

/**
 * `GET /config/asset-tag-scheme/next-tag` query — the pattern to preview. The affixes are taken
 * VERBATIM from the query (an absent affix means "no affix", never "reuse the saved one"), so the
 * settings editor can preview the IN-PROGRESS pattern it is composing before saving. `from` is the
 * counter floor to walk from; omit it to use the instance's stored `nextNumber`.
 *
 * Why the affixes are not inferred server-side: the editor's whole job is to preview an unsaved
 * pattern, and "the operator cleared the prefix" must be distinguishable from "the operator sent no
 * prefix key". Verbatim affixes make the two identical, which is the only unambiguous reading.
 */
export const AssetTagNextPreviewQuerySchema = z.object({
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  width: z.coerce.number().int().min(0).max(ASSET_TAG_WIDTH_MAX).optional(),
  /** Counter floor for the skip-existing walk; omit to use the stored `nextNumber`. */
  from: z.coerce.number().int().min(0).optional(),
});
export type AssetTagNextPreviewQuery = z.infer<
  typeof AssetTagNextPreviewQuerySchema
>;

/**
 * `GET /config/asset-tag-scheme/next-tag` response — the number the SKIP-EXISTING selection
 * (ADR-0068 §1) picks for this pattern, and its rendered tag.
 *
 * `number` is the smallest `n >= fromNumber` whose rendered tag is not already on a LIVE asset —
 * chosen by the SAME selection the allocator runs, over the same live estate. It is therefore what
 * the allocator would pick for this pattern at this instant; it is NOT a reservation (nothing is
 * consumed and no counter moves), so a create that lands first still wins the slot and the next
 * preview moves on. `skippedCount` = `number - fromNumber`: how many already-taken numbers the walk
 * stepped over, which is exactly the signal the operator needs to tell a working counter from a
 * broken one.
 *
 * `exhausted` mirrors the allocator's int4-ceiling freeze: when the first free slot is past
 * `INT4_MAX` there is nothing allocatable, so `number` and `tag` are BOTH null. Outside that case
 * both are non-null — they always move together (enforced below), so a caller never has to reason
 * about a tag with no number behind it.
 */
export const AssetTagNextPreviewSchema = z
  .object({
    /** The counter floor the walk started from (the request's `from`, or the stored `nextNumber`). */
    fromNumber: z.number().int(),
    /** The first free number, or null when the sequence is exhausted past int4. */
    number: z.number().int().nullable(),
    /** `renderAssetTag(pattern, number)`, or null when the sequence is exhausted. */
    tag: z.string().nullable(),
    /** How many already-taken numbers the skip-existing walk stepped over. */
    skippedCount: z.number().int(),
    /** True when the first free slot is past the int4 ceiling (the allocator would 400). */
    exhausted: z.boolean(),
  })
  .refine((value) => (value.number === null) === (value.tag === null), {
    message: "`number` and `tag` must both be present or both be null",
    path: ["tag"],
  });
export type AssetTagNextPreview = z.infer<typeof AssetTagNextPreviewSchema>;
