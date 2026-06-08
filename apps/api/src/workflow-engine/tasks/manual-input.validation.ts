import { BadRequestException } from '@nestjs/common';
import type { ManualInputField } from '@lazyit/shared';

/**
 * Validate a human's manual-task submission against the step's declared `inputFields` (ADR-0054 §scope).
 * The input is UNTRUSTED (never an expression — no SSTI) and redaction-sensitive (may carry PII). Pure +
 * framework-light (only the Nest 400) so it is unit-testable in isolation.
 *
 *  - A `required` field that is missing / null / empty ⇒ 400.
 *  - Each present value must match its field `type` (text→string, number→finite number, boolean→bool,
 *    select→one of `options`).
 *  - Unknown keys (not a declared field) are REJECTED (no smuggling extra data into `ctx.steps`).
 *
 * Returns the cleaned record (only declared fields, undefined omitted) to merge into the run context.
 */
export function validateManualInput(
  fields: readonly ManualInputField[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      throw new BadRequestException(`Unknown input field "${key}"`);
    }
  }

  const cleaned: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.name];
    const isEmpty = value === undefined || value === null || value === '';
    if (isEmpty) {
      if (field.required) {
        throw new BadRequestException(`Field "${field.name}" is required`);
      }
      continue;
    }
    switch (field.type) {
      case 'text':
        if (typeof value !== 'string') {
          throw new BadRequestException(`Field "${field.name}" must be text`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BadRequestException(
            `Field "${field.name}" must be a number`,
          );
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new BadRequestException(
            `Field "${field.name}" must be a boolean`,
          );
        }
        break;
      case 'select':
        if (typeof value !== 'string') {
          throw new BadRequestException(
            `Field "${field.name}" must be a selected value`,
          );
        }
        if (field.options && !field.options.includes(value)) {
          throw new BadRequestException(
            `Field "${field.name}" must be one of: ${field.options.join(', ')}`,
          );
        }
        break;
      default:
        throw new BadRequestException(
          `Field "${field.name}" has an unsupported type`,
        );
    }
    cleaned[field.name] = value;
  }
  return cleaned;
}
