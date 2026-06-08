import { BadRequestException } from '@nestjs/common';
import type { ManualInputField } from '@lazyit/shared';
import { validateManualInput } from './manual-input.validation';

const field = (
  over: Partial<ManualInputField> & { name: string },
): ManualInputField => ({
  label: over.name,
  type: 'text',
  required: false,
  ...over,
});

describe('validateManualInput', () => {
  it('accepts a valid typed submission and returns only declared fields', () => {
    const fields: ManualInputField[] = [
      field({ name: 'team', type: 'text', required: true }),
      field({ name: 'count', type: 'number' }),
      field({ name: 'urgent', type: 'boolean' }),
      field({ name: 'tier', type: 'select', options: ['gold', 'silver'] }),
    ];
    const cleaned = validateManualInput(fields, {
      team: 'Platform',
      count: 3,
      urgent: true,
      tier: 'gold',
    });
    expect(cleaned).toEqual({
      team: 'Platform',
      count: 3,
      urgent: true,
      tier: 'gold',
    });
  });

  it('rejects a missing required field', () => {
    expect(() =>
      validateManualInput([field({ name: 'team', required: true })], {}),
    ).toThrow(BadRequestException);
  });

  it('omits an absent optional field', () => {
    expect(validateManualInput([field({ name: 'note' })], {})).toEqual({});
  });

  it('rejects a type mismatch', () => {
    expect(() =>
      validateManualInput([field({ name: 'count', type: 'number' })], {
        count: 'x',
      }),
    ).toThrow(/must be a number/);
  });

  it('rejects a select value outside its options', () => {
    expect(() =>
      validateManualInput(
        [field({ name: 'tier', type: 'select', options: ['gold'] })],
        { tier: 'bronze' },
      ),
    ).toThrow(/must be one of/);
  });

  it('rejects an unknown (undeclared) field — no smuggling extra data', () => {
    expect(() =>
      validateManualInput([field({ name: 'team' })], {
        team: 'A',
        secret: 'x',
      }),
    ).toThrow(/Unknown input field/);
  });
});
