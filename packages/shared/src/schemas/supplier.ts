import { z } from "zod";
import { isSafeApplicationUrl } from "./application";
import { pageSchema } from "./pagination";
import { optionalText, requireAtLeastOneKey } from "./primitives";

/**
 * Supplier — who the team buys from and pays (a reseller, a wholesaler, a CSP), ADR-0099 §2. NOT a
 * manufacturer (`AssetModel.manufacturer`) and NOT a publisher (`Application.vendor`). Entry is light (CEO
 * decision D-D): only `name` is required, and neither `name` nor `taxId` is unique — a likely duplicate is
 * a suggestion, never a refusal. Gated by the `purchaseOrder:*` permissions. Single source of truth for api
 * and web. See docs/02-domain/entities/supplier.md.
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

/** A website: a scheme-less host or http(s); the dangerous schemes are refused (same rule as Application.url). */
const SupplierWebsiteSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isSafeApplicationUrl, {
    message:
      "website must be a scheme-less host or use http(s); javascript:, data:, vbscript: and file: are not allowed",
  });

/** A contact email (trimmed). */
const ContactEmailSchema = z.string().trim().max(254).pipe(z.email());

/** The full persisted Supplier (API representation of the `suppliers` row). */
export const SupplierSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  taxId: z.string().nullable(),
  website: z.string().nullable(),
  salesContactName: z.string().nullable(),
  salesContactEmail: z.string().nullable(),
  salesContactPhone: z.string().nullable(),
  // The support / RMA contact, separate from sales.
  supportContactName: z.string().nullable(),
  supportContactEmail: z.string().nullable(),
  supportContactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** The editable fields, as a create accepts them: only `name` is required. */
const supplierWriteShape = {
  taxId: optionalText(50),
  website: SupplierWebsiteSchema.optional(),
  salesContactName: optionalText(200),
  salesContactEmail: ContactEmailSchema.optional(),
  salesContactPhone: optionalText(50),
  supportContactName: optionalText(200),
  supportContactEmail: ContactEmailSchema.optional(),
  supportContactPhone: optionalText(50),
  notes: optionalText(2000),
};

/** Payload to create a Supplier. Only `name` is required; nothing is unique. */
export const CreateSupplierSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  ...supplierWriteShape,
});

/**
 * Partial update; any subset of the editable fields (an empty body is rejected). Every optional field
 * accepts `null` to clear it; `name` cannot be cleared.
 */
export const UpdateSupplierSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      taxId: z.string().trim().min(1).max(50).nullable(),
      website: SupplierWebsiteSchema.nullable(),
      salesContactName: z.string().trim().min(1).max(200).nullable(),
      salesContactEmail: ContactEmailSchema.nullable(),
      salesContactPhone: z.string().trim().min(1).max(50).nullable(),
      supportContactName: z.string().trim().min(1).max(200).nullable(),
      supportContactEmail: ContactEmailSchema.nullable(),
      supportContactPhone: z.string().trim().min(1).max(50).nullable(),
      notes: z.string().trim().min(1).max(2000).nullable(),
    })
    .partial(),
);

/**
 * The fields a merge may fill on the supplier that stays: every optional text field, never the name. A field
 * is filled only where the kept supplier has none and the duplicate has one; nothing is ever overwritten
 * (ADR-0099, merge suppliers, #1496).
 */
export const SUPPLIER_MERGE_FIELDS = [
  "taxId",
  "website",
  "salesContactName",
  "salesContactEmail",
  "salesContactPhone",
  "supportContactName",
  "supportContactEmail",
  "supportContactPhone",
  "notes",
] as const;
export const SupplierMergeFieldSchema = z.enum(SUPPLIER_MERGE_FIELDS);

/** `POST /suppliers/:id/merge` — merge the duplicate `sourceId` into the supplier `:id`, which stays. */
export const SupplierMergeSchema = z.strictObject({
  sourceId: z.cuid(),
});

/**
 * `GET /suppliers/:id/merge-preview?sourceId=` — what a merge would do, read without writing:
 *   - `purchases` — how many purchases move from the duplicate, live and archived (all of them move);
 *   - `fill` — the kept supplier's empty fields the duplicate's values would fill;
 *   - `kept` — fields both hold with different values: the kept supplier's value stays, the duplicate's is
 *     not copied (it remains on the archived duplicate).
 */
export const SupplierMergePreviewSchema = z.object({
  target: SupplierSchema,
  source: SupplierSchema,
  purchases: z.object({
    live: z.number().int().min(0),
    archived: z.number().int().min(0),
  }),
  fill: z.array(z.object({ field: SupplierMergeFieldSchema, value: z.string() })),
  kept: z.array(
    z.object({
      field: SupplierMergeFieldSchema,
      value: z.string(),
      sourceValue: z.string(),
    }),
  ),
});

/** The merge's answer: the kept supplier as saved, how many purchases moved, which fields were filled. */
export const SupplierMergeResultSchema = z.object({
  supplier: SupplierSchema,
  movedPurchases: z.number().int().min(0),
  filledFields: z.array(SupplierMergeFieldSchema),
});

/** Paginated `GET /suppliers` envelope (ADR-0030). */
export const SupplierListPageSchema = pageSchema(SupplierSchema);

export type Supplier = z.infer<typeof SupplierSchema>;
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;
export type UpdateSupplier = z.infer<typeof UpdateSupplierSchema>;
export type SupplierListPage = z.infer<typeof SupplierListPageSchema>;
export type SupplierMergeField = z.infer<typeof SupplierMergeFieldSchema>;
export type SupplierMerge = z.infer<typeof SupplierMergeSchema>;
export type SupplierMergePreview = z.infer<typeof SupplierMergePreviewSchema>;
export type SupplierMergeResult = z.infer<typeof SupplierMergeResultSchema>;
