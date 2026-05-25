import { z } from "zod";

/**
 * Application — something a User can be granted access to: a SaaS product (Jira, GitHub, AWS), an
 * internal system, or a technical service (VPN, AD group). The catalog of access targets. Single
 * source of truth for api and web. See docs/02-domain/entities/application.md and
 * docs/03-decisions/0023-access-management-design.md.
 *
 * Date fields are ISO-8601 strings (the wire shape) — see the note in application-category.ts.
 */

// TODO(metadata): once applications need typed extras (ssoProvider, ownerTeam, externalIds, …),
// validate this against a real schema. For now any JSON object is accepted — same debt as
// Asset.specs / Article.metadata. See docs/03-decisions/0007-flexible-asset-specs-jsonb.md.
const ApplicationMetadataSchema = z.record(z.string(), z.unknown());

/**
 * `url` is stored as a free string, not strictly URL-validated: internal IT targets are often
 * scheme-less hosts (e.g. `vpn.corp.local`) that `z.url()` would reject. Kept lenient on purpose.
 */
const ApplicationUrlSchema = z.string().trim().min(1).max(2048);

/** The full persisted Application entity (API representation of the `applications` row). */
export const ApplicationSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  url: z.string().nullable(),
  vendor: z.string().nullable(),
  categoryId: z.cuid().nullable(),
  isCritical: z.boolean(),
  metadata: ApplicationMetadataSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an Application. Only `name` is required; `isCritical` defaults to false. */
export const CreateApplicationSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).optional(),
  url: ApplicationUrlSchema.optional(),
  vendor: z.string().trim().min(1).max(200).optional(),
  categoryId: z.cuid().optional(),
  isCritical: z.boolean().default(false),
  metadata: ApplicationMetadataSchema.optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

/** Partial update; any subset of the editable fields. */
export const UpdateApplicationSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
    url: ApplicationUrlSchema,
    vendor: z.string().trim().min(1).max(200),
    categoryId: z.cuid(),
    isCritical: z.boolean(),
    metadata: ApplicationMetadataSchema,
    notes: z.string().trim().min(1).max(2000),
  })
  .partial();

export type Application = z.infer<typeof ApplicationSchema>;
export type CreateApplication = z.infer<typeof CreateApplicationSchema>;
export type UpdateApplication = z.infer<typeof UpdateApplicationSchema>;
