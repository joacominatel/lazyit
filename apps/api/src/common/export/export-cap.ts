import { UnprocessableEntityException } from '@nestjs/common';
import { DATA_EXPORT_ROW_CAP } from '@lazyit/shared';

/** Refuse before the first byte: an export above the cap is never truncated. */
export function assertWithinCap(
  rowCount: number,
  cap: number = DATA_EXPORT_ROW_CAP,
): void {
  if (rowCount > cap) {
    throw new UnprocessableEntityException(
      `This export matches ${rowCount} rows, more than the ${cap} an export can hold. Narrow your filters and try again.`,
    );
  }
}
