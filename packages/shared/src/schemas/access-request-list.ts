import { z } from "zod";
import { GrantProvisioningSchema } from "./access-grant";
import { AccessRequestSchema } from "./access-request";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /access-requests` envelope:
 * `{ items: AccessRequest[], total, limit, offset }`. Offset pagination per ADR-0030 — never a bare
 * array. Newest-first. The item is the full {@link AccessRequestSchema} (no relations are inlined on
 * the list), so only the page envelope is added.
 */
export const AccessRequestListPageSchema = pageSchema(AccessRequestSchema);

export type AccessRequestListPage = z.infer<typeof AccessRequestListPageSchema>;

/**
 * A request as the self-scope `GET /access-requests/mine` returns it (#1700): the full
 * {@link AccessRequestSchema} plus the coarse `provisioning` status of the grant an approval created.
 * `null` when there is no grant to provision (PENDING or DENIED); optional so a client tolerates an API
 * that predates it. The estate-wide `GET /access-requests` does not carry it.
 */
export const MyAccessRequestSchema = AccessRequestSchema.extend({
  provisioning: GrantProvisioningSchema.nullable().optional(),
});
export type MyAccessRequest = z.infer<typeof MyAccessRequestSchema>;

/** Paginated self-scope `GET /access-requests/mine` envelope (#1700). */
export const MyAccessRequestListPageSchema = pageSchema(MyAccessRequestSchema);

export type MyAccessRequestListPage = z.infer<
  typeof MyAccessRequestListPageSchema
>;
