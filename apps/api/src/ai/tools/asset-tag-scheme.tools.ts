import { BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import {
  ASSET_TAG_AFFIX_MAX,
  ASSET_TAG_WIDTH_MAX,
  UpdateAssetTagSchemeSchema,
  type AiActionPreview,
  type AiEntityRef,
  type UpdateAssetTagScheme,
} from '@lazyit/shared';
import { AssetTagSchemeController } from '../../asset-tag-scheme/asset-tag-scheme.controller';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolRunOutput,
  type AiToolRuntime,
  type AiToolset,
} from '../core/tool-descriptor';
import { asRow, iso, str, type Row } from './reference.tools';

/**
 * The ASSET TAG SCHEME tools (#1394). CEO decision: the assistant READS the instance's tag scheme so it
 * follows it — it may set an individual asset's tag, but it never changes the instance-wide scheme unless
 * the person explicitly asks to change the general asset tag scheme.
 *
 * - `asset_tag_scheme_get` (read) — the scheme and the tag the next asset created without `assetTag`
 *   would get (the settings route's own skip-existing preview). The routes need `settings:manage` and are
 *   human-only, so a caller without it gets a plain "not visible" answer instead of an error: the tag is
 *   then left to the server (omit `assetTag`).
 * - `asset_tag_scheme_update` (elevated) — changes the scheme. Never automatic: `elevated`, so the chat
 *   always waits for the user (auto-approve excludes it). The card shows only the fields that change,
 *   before → after, plus the next tag before → after; it names the scheme as its target with its
 *   `updatedAt` as precondition (`STALE` on any change, including the counter moving because an asset was
 *   tagged in between). `INSTANCE_CONFIGURATION` is its warning — not a step-up warning (CEO: passwords
 *   only for critical applications).
 *
 * The seed suggestion and the backfill stay unexposed: the backfill rewrites EXISTING tags in bulk
 * (forward-only, no undo), and the seed suggestion only serves the settings editor.
 */

type Change = AiActionPreview['changes'][number];

/** The scheme row's fixed key (`AssetTagSchemeService.SINGLETON_ID`). */
const SCHEME_ID = 'singleton';
const SCHEME_LABEL = 'Asset tag scheme';

/**
 * The anchor of a scheme that was never configured. `GET` answers the unset default with `updatedAt` =
 * now, which would make every approval STALE; the default is recognized and anchored on a fixed instant
 * instead (a row written in between with the very same default values changes nothing the card showed).
 */
const UNSET_ANCHOR = new Date(0).toISOString();

interface Scheme {
  enabled: boolean;
  prefix: string | null;
  suffix: string | null;
  width: number | null;
  nextNumber: number;
  createdAt: string | null;
  updatedAt: string | null;
}

function schemeOf(value: unknown): Scheme {
  const row = asRow(value);
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const text = (v: unknown): string | null => str(iso(v));
  return {
    enabled: row.enabled === true,
    prefix: str(row.prefix),
    suffix: str(row.suffix),
    width: num(row.width),
    nextNumber: num(row.nextNumber) ?? 1,
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

function isUnsetDefault(s: Scheme): boolean {
  return (
    !s.enabled &&
    s.prefix === null &&
    s.suffix === null &&
    (s.width === null || s.width === 0) &&
    s.nextNumber === 1 &&
    s.createdAt === s.updatedAt
  );
}

const readScheme = async (rt: AiToolRuntime): Promise<Scheme> =>
  schemeOf(await rt.call(AssetTagSchemeController, 'get'));

/** The tag the allocator would pick for a pattern (the route's skip-existing preview, read-only). */
async function nextTagOf(
  rt: AiToolRuntime,
  pattern: {
    prefix: string | null;
    suffix: string | null;
    width: number | null;
  },
  from?: number,
): Promise<{
  tag: string | null;
  number: number | null;
  skippedCount: number;
  exhausted: boolean;
}> {
  // Affixes are taken VERBATIM by the route (absent = no affix), so an unset one is simply not sent.
  const query: Record<string, string> = {};
  if (pattern.prefix !== null) query.prefix = pattern.prefix;
  if (pattern.suffix !== null) query.suffix = pattern.suffix;
  if (pattern.width !== null) query.width = String(pattern.width);
  if (from !== undefined) query.from = String(from);
  const row = asRow(
    await rt.call(AssetTagSchemeController, 'previewNextTag', { query }),
  );
  return {
    tag: str(row.tag),
    number: typeof row.number === 'number' ? row.number : null,
    skippedCount: typeof row.skippedCount === 'number' ? row.skippedCount : 0,
    exhausted: row.exhausted === true,
  };
}

// ─── asset_tag_scheme_get ────────────────────────────────────────────────────────────────────────────

const NOT_VISIBLE =
  'The asset tag scheme is not visible to you (it is instance configuration, readable with the ' +
  'settings permission). Do not invent a tag: when creating an asset, use the tag the person gives, or ' +
  'omit assetTag and lazyit assigns the next tag itself if the instance has a scheme turned on.';

const assetTagSchemeGet = defineTool({
  name: 'asset_tag_scheme_get',
  title: 'Read the asset tag scheme',
  description:
    "Read this instance's asset tag scheme (the pattern new asset tags follow, e.g. LAP-00042) and the " +
    'tag the next asset created without an assetTag would get. Read it before creating assets when tags ' +
    'matter. When the scheme is on, OMIT assetTag on asset creation unless the person gives a specific ' +
    'tag: lazyit assigns the next free tag of the scheme itself — never compose one from the pattern. ' +
    'When it is off, an asset created without assetTag gets no tag. To give one asset a specific tag, set ' +
    'it on that asset; the scheme itself changes only with asset_tag_scheme_update, when explicitly asked.',
  domain: 'platform',
  class: 'read',
  input: z.strictObject({}),
  bindings: [
    bind(AssetTagSchemeController, 'get'),
    bind(AssetTagSchemeController, 'previewNextTag'),
  ],
  async run(_input, rt): Promise<AiToolRunOutput<Row>> {
    let scheme: Scheme;
    try {
      scheme = await readScheme(rt);
    } catch (err) {
      // Authorized like the route: a caller it refuses gets the guidance, not an error to retry.
      if (err instanceof HttpException && err.getStatus() === 403) {
        return {
          data: { visible: false, guidance: NOT_VISIBLE },
          summary: 'The asset tag scheme is not visible to you.',
        };
      }
      throw err;
    }
    const next = await nextTagOf(rt, scheme);
    const pattern = `${scheme.prefix ?? ''}{number${
      scheme.width ? `, ${scheme.width} digits` : ''
    }}${scheme.suffix ?? ''}`;
    const guidance = scheme.enabled
      ? 'The scheme is ON. When creating an asset, omit assetTag unless the person gives a specific tag: ' +
        'lazyit assigns the next free tag of the scheme itself. Never compose a tag from the pattern — ' +
        'a composed tag skips the counter. Existing tags are never rewritten by the scheme.'
      : 'The scheme is OFF: an asset created without assetTag gets no tag. Use the tag the person gives; ' +
        'never invent one.';
    return {
      data: {
        visible: true,
        enabled: scheme.enabled,
        pattern: untrusted(pattern),
        prefix: untrusted(scheme.prefix),
        suffix: untrusted(scheme.suffix),
        width: scheme.width,
        nextNumber: scheme.nextNumber,
        nextTag: next.exhausted
          ? null
          : {
              tag: untrusted(next.tag),
              number: next.number,
              skippedCount: next.skippedCount,
            },
        exhausted: next.exhausted,
        updatedAt: isUnsetDefault(scheme) ? null : scheme.updatedAt,
        guidance,
      },
      summary: scheme.enabled
        ? `The asset tag scheme is on; the next tag would be ${untrusted(next.tag) ?? 'none (the sequence is exhausted)'}.`
        : 'The asset tag scheme is off: assets get no automatic tag.',
    };
  },
});

// ─── asset_tag_scheme_update ─────────────────────────────────────────────────────────────────────────

const affixInput = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(ASSET_TAG_AFFIX_MAX)
    .nullable()
    .optional()
    .describe(`${what}; null removes it. Omit to keep the current one.`);

const updateInput = z.strictObject({
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Turn automatic tagging on or off. Omit to keep the current state.',
    ),
  prefix: affixInput('Text before the number, e.g. "LAP-"'),
  suffix: affixInput('Text after the number'),
  width: z
    .number()
    .int()
    .min(0)
    .max(ASSET_TAG_WIDTH_MAX)
    .nullable()
    .optional()
    .describe(
      'Zero-pad the number to this many digits (5 → 00042); 0 or null = no padding. Omit to keep it.',
    ),
  startNumber: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .optional()
    .describe(
      'Re-seed the counter: the next number to assign. Numbers already on live assets are still skipped. ' +
        'Omit to leave the counter where it is.',
    ),
});
type UpdateInput = z.output<typeof updateInput>;

/**
 * The route's full `PUT` body: the input merged over the scheme as read now, validated with the route's
 * own schema. The route replaces affixes wholesale (an absent affix is cleared), so a field the person did
 * not mention must be sent with its current value.
 */
function bodyOf(current: Scheme, input: UpdateInput): UpdateAssetTagScheme {
  const pick = <T>(given: T | undefined, now: T): T =>
    given === undefined ? now : given;
  const prefix = pick(input.prefix, current.prefix);
  const suffix = pick(input.suffix, current.suffix);
  const width = pick(input.width, current.width);
  const parsed = UpdateAssetTagSchemeSchema.safeParse({
    enabled: pick(input.enabled, current.enabled),
    ...(prefix !== null ? { prefix } : {}),
    ...(suffix !== null ? { suffix } : {}),
    ...(width !== null ? { width } : {}),
    ...(input.startNumber !== undefined
      ? { startNumber: input.startNumber }
      : {}),
  });
  if (!parsed.success) {
    throw new BadRequestException(
      `The resulting asset tag scheme is not valid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'scheme'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

const schemeRef = (op: AiEntityRef['op']): AiEntityRef => ({
  type: 'assetTagScheme',
  id: SCHEME_ID,
  op,
  label: SCHEME_LABEL,
});

/** The next tag as the card shows it: the tag, or why there is none. */
function nextTagText(
  enabled: boolean,
  next: { tag: string | null; exhausted: boolean },
): string {
  if (!enabled) return 'None (automatic tagging is off)';
  return next.tag ?? 'None (the sequence is exhausted)';
}

const assetTagSchemeUpdate = defineTool({
  name: 'asset_tag_scheme_update',
  title: 'Change the asset tag scheme',
  description:
    "Change this instance's GENERAL asset tag scheme (instance-wide configuration): turn automatic " +
    'tagging on or off, change the prefix, suffix or zero-padding, or re-seed the counter. Use it ONLY ' +
    'when the person explicitly asks to change the general / instance-wide asset tag scheme. Never use ' +
    "it to make one asset's tag fit — set that asset's own tag instead. Only the fields given change. It " +
    'affects the tags assigned from now on; existing asset tags are never rewritten. Read the current ' +
    'scheme first with asset_tag_scheme_get.',
  domain: 'platform',
  class: 'elevated',
  destructive: true,
  input: updateInput,
  bindings: [
    bind(AssetTagSchemeController, 'update'),
    bind(AssetTagSchemeController, 'get'),
    bind(AssetTagSchemeController, 'previewNextTag'),
  ],
  async run(input, rt) {
    // In the chat the approval re-read the scheme and checked its version (STALE); over MCP there is no
    // card, and the merge is made on the scheme as read now.
    const current = await readScheme(rt);
    const body = bodyOf(current, input);
    const updated = schemeOf(
      await rt.call(AssetTagSchemeController, 'update', { body }),
    );
    return {
      data: {
        enabled: updated.enabled,
        prefix: untrusted(updated.prefix),
        suffix: untrusted(updated.suffix),
        width: updated.width,
        nextNumber: updated.nextNumber,
        updatedAt: updated.updatedAt,
      },
      summary: `Updated the asset tag scheme (automatic tagging ${
        updated.enabled ? 'on' : 'off'
      }). Existing asset tags are unchanged.`,
      entityRefs: [schemeRef('updated')],
    };
  },
  async preview(input, rt) {
    const current = await readScheme(rt);
    const body = bodyOf(current, input);
    const after = {
      enabled: body.enabled,
      prefix: body.prefix ?? null,
      suffix: body.suffix ?? null,
      width: body.width ?? null,
    };
    const changes: Change[] = [];
    if (after.enabled !== current.enabled) {
      changes.push({
        field: 'enabled',
        before: current.enabled,
        after: after.enabled,
        valueKind: 'boolean',
      });
    }
    if (after.prefix !== current.prefix) {
      changes.push({
        field: 'prefix',
        before: current.prefix,
        after: after.prefix,
        valueKind: 'text',
      });
    }
    if (after.suffix !== current.suffix) {
      changes.push({
        field: 'suffix',
        before: current.suffix,
        after: after.suffix,
        valueKind: 'text',
      });
    }
    // 0 and null both mean "no padding".
    if ((after.width ?? 0) !== (current.width ?? 0)) {
      changes.push({
        field: 'width',
        before: current.width,
        after: after.width,
        valueKind: 'number',
      });
    }
    if (
      body.startNumber !== undefined &&
      body.startNumber !== current.nextNumber
    ) {
      changes.push({
        field: 'nextNumber',
        before: current.nextNumber,
        after: body.startNumber,
        valueKind: 'number',
      });
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Nothing to change: the asset tag scheme already has these values',
      );
    }
    const [nextBefore, nextAfter] = await Promise.all([
      nextTagOf(rt, current),
      nextTagOf(rt, after, body.startNumber),
    ]);
    const before = nextTagText(current.enabled, nextBefore);
    const afterTag = nextTagText(after.enabled, nextAfter);
    if (before !== afterTag) {
      changes.push({
        field: 'nextTag',
        before,
        after: afterTag,
        valueKind: 'text',
      });
    }
    const target = schemeRef('updated');
    if (!isUnsetDefault(current) && current.updatedAt === null) {
      // Never a card without a version check: a scheme without a timestamp is a handler bug.
      throw new Error('The asset tag scheme carries no updatedAt');
    }
    return {
      target,
      changes,
      warnings: ['INSTANCE_CONFIGURATION'],
      impacted: [],
      untrustedSources: [],
      elevated: true,
      stepUpRequired: false,
      precondition: {
        entity: target,
        updatedAt: isUnsetDefault(current) ? UNSET_ANCHOR : current.updatedAt!,
      },
    };
  },
});

/**
 * The asset tag scheme toolset (#1394). Its domain is `platform` (instance configuration); the platform
 * toolset lists the rest of that surface as unexposed.
 */
export const assetTagSchemeToolset: AiToolset = {
  domain: 'platform',
  tools: [assetTagSchemeGet, assetTagSchemeUpdate],
  unexposed: [
    unexposed(
      AssetTagSchemeController,
      ['seedSuggestion', 'backfillPreview', 'backfillApply'],
      'Not exposed (CEO decision, #1394): the backfill rewrites EXISTING asset tags in bulk (forward-only, ' +
        'no undo) and the seed suggestion only serves the settings editor; they stay in the lazyit settings. ' +
        'The scheme itself is read and changed by asset_tag_scheme_get / asset_tag_scheme_update.',
    ),
  ],
};
