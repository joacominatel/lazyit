import type { AiEntityOp, AiEntityRef, AiEntityType } from '@lazyit/shared';

/**
 * THE REFERENCE RESOLVER (tools-and-execution.md §7 "References", §8.5; synthesis §4.3).
 *
 * Tools accept human-readable references — an asset by id, asset tag or serial; a user by id, email or
 * `"me"`; an application by id or exact name; an article by id or slug — and the preview and the result
 * name entities with a label the user recognizes. This module is the one place that turns a reference
 * into exactly one entity, or fails with a tool error:
 *
 *   - a raw id passes straight through (the write handler is the authority; an SA with write-only grants
 *     still works);
 *   - otherwise the tool's `lookup` runs — and it MUST read through `rt.call` on a bound read handler, so
 *     a resolution the caller may not read fails as the route would (403/404), never leaking a match;
 *   - no match → `NOT_FOUND`; more than one → `AMBIGUOUS_REFERENCE` with up to five candidates, so the
 *     model asks the user instead of guessing.
 *
 * Mechanism only: which handler finds an asset by tag belongs to the tool unit that owns the domain.
 * Tools reach it as `rt.resolve(spec)`.
 */

/** One entity a lookup found, with the label a person recognizes (a tag, an email, a title). */
export interface AiReferenceCandidate {
  id: string;
  label: string;
  slug?: string;
}

export interface AiReferenceSpec {
  type: AiEntityType;
  /** What the model passed: an id, a tag, a serial, an email, a slug, an exact name. */
  reference: string;
  /** When true the reference is taken as the id without a lookup (e.g. a uuid or cuid pattern). */
  isId?: (reference: string) => boolean;
  /**
   * The candidates exactly matching `reference`, read through bound handlers only. Returning more than
   * one is how ambiguity is reported. When absent, only ids resolve.
   */
  lookup?: (reference: string) => Promise<readonly AiReferenceCandidate[]>;
}

/** A resolved reference. `label` is absent when a raw id passed through without a lookup. */
export interface AiResolvedReference {
  type: AiEntityType;
  id: string;
  label?: string;
  slug?: string;
}

/** The candidates an ambiguity error carries (the model shows them to the user). */
export const AI_AMBIGUITY_SAMPLE = 5;

/**
 * A reference that does not name exactly one entity. The error mapper turns it into the tool error
 * `NOT_FOUND` (404) or `AMBIGUOUS_REFERENCE` (409) with the candidates in the `hint`.
 */
export class AiReferenceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'AMBIGUOUS_REFERENCE',
    message: string,
    readonly candidates: readonly AiResolvedReference[] = [],
  ) {
    super(message);
    this.name = 'AiReferenceError';
  }

  /** "Candidates: LT-1 (asset ck1…), LT-10 (asset ck2…)" — labels and ids only, never other fields. */
  get hint(): string | undefined {
    if (this.candidates.length === 0) return undefined;
    return `Candidates: ${this.candidates
      .map((c) => `${c.label ?? c.id} (${c.type} ${c.id})`)
      .join(', ')}`;
  }
}

/** Resolve one reference to exactly one entity, or throw an {@link AiReferenceError}. */
export async function resolveReference(
  spec: AiReferenceSpec,
): Promise<AiResolvedReference> {
  const reference = spec.reference.trim();
  if (reference.length === 0) {
    throw new AiReferenceError('NOT_FOUND', `Empty ${spec.type} reference`);
  }
  if (spec.isId?.(reference) || !spec.lookup) {
    return { type: spec.type, id: reference };
  }
  const found = await spec.lookup(reference);
  // A lookup may return the same entity twice (matched by tag and by serial): dedupe by id.
  const unique = [...new Map(found.map((c) => [c.id, c])).values()];
  if (unique.length === 0) {
    throw new AiReferenceError(
      'NOT_FOUND',
      `No ${spec.type} matches "${reference}"`,
    );
  }
  if (unique.length > 1) {
    throw new AiReferenceError(
      'AMBIGUOUS_REFERENCE',
      `"${reference}" matches ${unique.length} ${spec.type} records; ask which one`,
      unique.slice(0, AI_AMBIGUITY_SAMPLE).map((c) => ({
        type: spec.type,
        id: c.id,
        label: c.label,
        ...(c.slug ? { slug: c.slug } : {}),
      })),
    );
  }
  const [one] = unique;
  return {
    type: spec.type,
    id: one.id,
    label: one.label,
    ...(one.slug ? { slug: one.slug } : {}),
  };
}

/** The entity ref a result or a preview carries for a resolved reference (R3). */
export function entityRefOf(
  resolved: AiResolvedReference,
  op: AiEntityOp,
  parent?: AiEntityRef['parent'],
): AiEntityRef {
  return {
    type: resolved.type,
    id: resolved.id,
    op,
    ...(resolved.label !== undefined ? { label: resolved.label } : {}),
    ...(resolved.slug !== undefined ? { slug: resolved.slug } : {}),
    ...(parent ? { parent } : {}),
  };
}
