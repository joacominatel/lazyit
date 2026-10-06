import { z } from "zod";

/**
 * Smart-entry suggestions (ADR-0099 §7) — `GET /suggestions/:field?q=&limit=`. For a free-text field
 * the user is typing, the values already used in lazyit, with how often and how recently, so the web can
 * rank "most used", "last used" and "closest match" and hint at near-duplicates. The values are returned
 * exactly as stored; normalizing, fuzzy matching and near-duplicate hints are the client's job.
 *
 * Each field reads one or more SOURCES (a column of a table), and each source is guarded by the read
 * permission that already guards that table. The API reads only the sources the caller may read and
 * refuses the field (403) when it may read none of them, so a suggestion never reveals more than the
 * caller could already list.
 *
 * | Field          | Sources (permission)                                                                       |
 * | -------------- | ------------------------------------------------------------------------------------------ |
 * | `supplierName` | supplier name (`purchaseOrder:read`)                                                       |
 * | `currency`     | purchase currency (`purchaseOrder:read`) · asset purchase currency (`asset:read`)          |
 * | `company`      | asset company (`asset:read`) · purchase company (`purchaseOrder:read`)                     |
 * | `manufacturer` | asset model manufacturer (`assetModel:read`) · purchase line manufacturer (`purchaseOrder:read`) |
 * | `lineModel`    | purchase line model text (`purchaseOrder:read`)                                            |
 * | `vendor`       | application vendor / publisher (`application:read`)                                         |
 * | `reference`    | purchase reference — the finance PO number (`purchaseOrder:read`) — #1473                  |
 * | `invoiceNumbers` | purchase invoice numbers (`purchaseOrder:read`) — #1473                                  |
 * | `lineDescription` | purchase line description (`purchaseOrder:read`) — #1473                                |
 * | `documentLabel` | asset document type label (`asset:read`) · purchase document type label (`purchaseOrder:read`) — #1476 |
 *
 * The purchase sources read live rows of live purchases only (a line of an archived purchase is archived
 * with it), and the document-label sources live documents of live assets and purchases. A repeated
 * `reference` is a hint, never a refusal (ADR-0099 §6): the web surfaces "a purchase with this reference
 * already exists" from it.
 */
export const SUGGESTION_FIELDS = [
  "supplierName",
  "currency",
  "company",
  "manufacturer",
  "lineModel",
  "vendor",
  "reference",
  "invoiceNumbers",
  "lineDescription",
  "documentLabel",
] as const;
export const SuggestionFieldSchema = z.enum(SUGGESTION_FIELDS);

/** Default and maximum number of suggestions per request. */
export const DEFAULT_SUGGESTION_LIMIT = 10;
export const MAX_SUGGESTION_LIMIT = 50;

/**
 * Query of `GET /suggestions/:field`. `q` narrows to values containing it (case-insensitive); without it
 * the most used values come first. A `limit` above the maximum is a 400, never clamped (ADR-0030).
 */
export const SuggestionQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SUGGESTION_LIMIT).default(DEFAULT_SUGGESTION_LIMIT),
});

/**
 * One suggested value: `count` = live rows holding it across the sources the caller may read;
 * `lastUsedAt` = the latest `updatedAt` among them. Values group by their exact stored text, so "Dell"
 * and "DELL" are two suggestions (the client hints at the near-duplicate). Ordered by `count` desc, then
 * `lastUsedAt` desc, then `value`.
 */
export const SuggestionSchema = z.object({
  value: z.string(),
  count: z.number().int().min(1),
  lastUsedAt: z.iso.datetime(),
});

export const SuggestionListSchema = z.array(SuggestionSchema);

export type SuggestionField = z.infer<typeof SuggestionFieldSchema>;
export type SuggestionQuery = z.infer<typeof SuggestionQuerySchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
