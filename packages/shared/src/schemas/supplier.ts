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

/** Paginated `GET /suppliers` envelope (ADR-0030). */
export const SupplierListPageSchema = pageSchema(SupplierSchema);

export type Supplier = z.infer<typeof SupplierSchema>;
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;
export type UpdateSupplier = z.infer<typeof UpdateSupplierSchema>;
export type SupplierListPage = z.infer<typeof SupplierListPageSchema>;
