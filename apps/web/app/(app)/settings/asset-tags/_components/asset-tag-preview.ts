/**
 * Pure presentation logic for the asset-tag scheme editor's preview card (#1180).
 *
 * Two decisions live here, kept out of the component so they are executable in a test rather than
 * asserted in prose:
 *
 *  1. **What the card shows when the scheme is OFF.** Nothing is allocated with the scheme off, so
 *     there is no next tag — and rendering the counter through `renderAssetTag` anyway is the exact
 *     defect this issue is about (`LZ-1000` on screen, `LZ-1001` allocated). Re-labelling that number
 *     "Tag shape" does not fix it; it only makes a wrong value harder to spot. So the off state
 *     renders a SHAPE: the affixes verbatim plus a described number slot ("4 digits"), which cannot
 *     be read as an allocatable value. `assetTagShapeParts` returns the parts rather than a string
 *     because the slot's copy is translated, and because a `#`-per-digit string would fuse with an
 *     affix that itself contains `#` (the reporting operator's own standard is `IT#1000` → `IT#####`).
 *
 *  2. **What the card shows while / after the server lookup.** The tag itself is a server read, so it
 *     has a pending state and a failure state, and those must not look alike: a failed query that
 *     falls back to the pending copy leaves the card on "Checking…" forever with nothing to retry.
 */

/** One segment of the rendered shape: literal affix text, or the slot the number would occupy. */
export type AssetTagShapePart =
  | { kind: "literal"; text: string }
  /** `width` is the zero-pad; `0` means "unpadded", i.e. a number of any length. */
  | { kind: "number"; width: number };

/** The live pattern the operator is composing — the editor's raw form fields. */
interface SchemePattern {
  prefix?: string | null;
  suffix?: string | null;
  width?: number | null;
}

/**
 * Break a pattern into the parts the card renders with the scheme OFF. Affixes are trimmed (the API
 * trims them on save, so the shape shows what the operator will actually get) and dropped when blank.
 * There is deliberately no number in the output — see the note above.
 */
export function assetTagShapeParts(scheme: SchemePattern): AssetTagShapePart[] {
  const parts: AssetTagShapePart[] = [];
  const prefix = scheme.prefix?.trim();
  const suffix = scheme.suffix?.trim();

  if (prefix) parts.push({ kind: "literal", text: prefix });
  parts.push({
    kind: "number",
    width: scheme.width && scheme.width > 0 ? scheme.width : 0,
  });
  if (suffix) parts.push({ kind: "literal", text: suffix });

  return parts;
}

/** What the preview card has to render right now. */
export type AssetTagPreviewState =
  /** Scheme off — no allocation happens, so there is a shape to show and no value. */
  | { kind: "shape" }
  /** The server lookup is in flight and has answered nothing yet. */
  | { kind: "loading" }
  /** The lookup failed; the card must say so and offer a retry. */
  | { kind: "error" }
  /** The first free number is past the int4 ceiling — the allocator would refuse. */
  | { kind: "exhausted" }
  /** The tag the next create would actually get, as computed by the server. */
  | { kind: "tag"; tag: string };

interface PreviewStateInput {
  /** Whether the scheme toggle is on — the query is idle when it is not. */
  enabled: boolean;
  /** The query is in its error state (TanStack `isError`). */
  isError: boolean;
  /** The server's answer, when there is one. */
  data?: { tag: string | null; exhausted: boolean };
}

/**
 * Decide what the card shows. The ORDER is the contract:
 *
 *   - `enabled` first, so a cached answer for the same pattern can never leak a number into the off
 *     state (the query is disabled, but TanStack still hands back whatever sits under the key);
 *   - failure before data, so a stale tag is never presented as the current one after a refresh fails;
 *   - `exhausted` before the tag, since an exhausted sequence carries a null tag by contract.
 */
export function assetTagPreviewState({
  enabled,
  isError,
  data,
}: PreviewStateInput): AssetTagPreviewState {
  if (!enabled) return { kind: "shape" };
  if (isError) return { kind: "error" };
  if (!data) return { kind: "loading" };
  if (data.exhausted || data.tag === null) return { kind: "exhausted" };
  return { kind: "tag", tag: data.tag };
}
