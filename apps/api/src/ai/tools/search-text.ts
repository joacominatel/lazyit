import { z } from 'zod';

/** The longest free-text search a tool accepts (the routes' own `q` has no tighter bound). */
export const AI_SEARCH_TEXT_MAX = 200;

/**
 * The optional free-text `query` of a search/list tool (#1374). Every such tool LISTS when there is no
 * text: an absent, empty or whitespace-only `query` means "no text filter", exactly as the route treats
 * an absent `q`. A model asked to "list every admin" often sends `query: ""` with the filter; rejecting
 * that as too short made it retry the same call instead of listing.
 *
 * The JSON Schema the channels list (`io: "input"`) is a plain optional string with a `maxLength`: the
 * blank-to-absent mapping is a transform on the output side, so it is not part of the listed schema.
 */
export function searchText(description: string) {
  return z
    .string()
    .trim()
    .max(AI_SEARCH_TEXT_MAX)
    .optional()
    .transform((value) => (value === '' ? undefined : value))
    .describe(
      `${description} Omit it to list by the other filters alone (no text filter).`,
    );
}
