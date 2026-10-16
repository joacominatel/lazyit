import {
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import {
  DELETE_RESOLUTION_REQUIRED,
  DeleteResolutionSchema,
  type DeleteResolution,
  type DeleteResolutionRequiredError,
} from '@lazyit/shared';

// Both absent means "no resolution": the delete then refuses with 409 while anything still points at the row.
export function parseDeleteResolution(
  strategy: string | undefined,
  targetId: string | undefined,
): DeleteResolution | undefined {
  if (strategy === undefined && targetId === undefined) return undefined;
  const parsed = DeleteResolutionSchema.safeParse({
    strategy,
    ...(targetId !== undefined ? { targetId } : {}),
  });
  if (!parsed.success) {
    throw new BadRequestException(
      'Invalid delete resolution: use strategy=detach, or strategy=move with a targetId',
    );
  }
  return parsed.data;
}

export function deleteResolutionRequired(
  what: string,
  dependents: Record<string, number>,
): ConflictException {
  const counts = Object.entries(dependents)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  const body: DeleteResolutionRequiredError = {
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: DELETE_RESOLUTION_REQUIRED,
    message: `${what} is still in use (${counts}). Choose one resolution for all of them: strategy=detach, or strategy=move with a targetId.`,
    dependents,
  };
  return new ConflictException(body);
}
