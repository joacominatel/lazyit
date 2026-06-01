import { createZodDto } from 'nestjs-zod';
import {
  AccessGrantListPageSchema,
  AccessGrantSchema,
  BatchResultSchema,
  BatchRevokeGrantsSchema,
  CreateAccessGrantSchema,
  RevokeAccessGrantSchema,
  UpdateAccessGrantExpirySchema,
  UpdateAccessGrantNotesSchema,
} from '@lazyit/shared';

// AccessGrant DTOs (validation + OpenAPI schema) from the shared zod schemas. Defined once and
// reused by the access-grants controller AND the nested /users/:id/access-grants and
// /applications/:id/access-grants endpoints — one class per schema keeps a single OpenAPI schema
// name. See docs/03-decisions/0018-api-documentation-swagger.md.
export class AccessGrantDto extends createZodDto(AccessGrantSchema) {}
// The paginated `GET /access-grants` envelope ({ items, total, limit, offset }) — ADR-0030.
export class AccessGrantListPageDto extends createZodDto(
  AccessGrantListPageSchema,
) {}
export class CreateAccessGrantDto extends createZodDto(
  CreateAccessGrantSchema,
) {}
export class RevokeAccessGrantDto extends createZodDto(
  RevokeAccessGrantSchema,
) {}
export class UpdateAccessGrantNotesDto extends createZodDto(
  UpdateAccessGrantNotesSchema,
) {}
export class UpdateAccessGrantExpiryDto extends createZodDto(
  UpdateAccessGrantExpirySchema,
) {}
// Bulk revoke (ADR-0030 amendment): the ids+notes payload and the per-item batch result envelope.
export class BatchRevokeGrantsDto extends createZodDto(
  BatchRevokeGrantsSchema,
) {}
export class BatchResultDto extends createZodDto(BatchResultSchema) {}
