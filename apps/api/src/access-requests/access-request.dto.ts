import { createZodDto } from 'nestjs-zod';
import {
  AccessRequestListPageSchema,
  AccessRequestSchema,
  CreateAccessRequestSchema,
  DenyAccessRequestSchema,
  MyAccessRequestListPageSchema,
} from '@lazyit/shared';

// AccessRequest DTOs (validation + OpenAPI schema) from the shared zod schemas — one class per schema
// keeps a single OpenAPI schema name (ADR-0018). ADR-0085.
export class AccessRequestDto extends createZodDto(AccessRequestSchema) {}
// The paginated `GET /access-requests` envelope ({ items, total, limit, offset }) — ADR-0030.
export class AccessRequestListPageDto extends createZodDto(
  AccessRequestListPageSchema,
) {}
// The self-scope `GET /access-requests/mine` envelope: each request carries the coarse `provisioning`
// of the grant its approval created, null when there is none (#1700).
export class MyAccessRequestListPageDto extends createZodDto(
  MyAccessRequestListPageSchema,
) {}
export class CreateAccessRequestDto extends createZodDto(
  CreateAccessRequestSchema,
) {}
export class DenyAccessRequestDto extends createZodDto(
  DenyAccessRequestSchema,
) {}
