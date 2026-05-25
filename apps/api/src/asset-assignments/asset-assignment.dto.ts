import { createZodDto } from 'nestjs-zod';
import {
  AssetAssignmentSchema,
  CreateAssetAssignmentSchema,
  ReleaseAssetAssignmentSchema,
  UpdateAssetAssignmentNotesSchema,
} from '@lazyit/shared';

// Assignment DTOs (validation + OpenAPI schema) from the shared zod schemas. Defined once and
// reused by the assignments controller AND the nested /assets/:id/assignments and
// /users/:id/assignments endpoints — one class per schema keeps a single OpenAPI schema name.
// See docs/03-decisions/0018-api-documentation-swagger.md.
export class AssetAssignmentDto extends createZodDto(AssetAssignmentSchema) {}
export class CreateAssetAssignmentDto extends createZodDto(
  CreateAssetAssignmentSchema,
) {}
export class ReleaseAssetAssignmentDto extends createZodDto(
  ReleaseAssetAssignmentSchema,
) {}
export class UpdateAssetAssignmentNotesDto extends createZodDto(
  UpdateAssetAssignmentNotesSchema,
) {}
