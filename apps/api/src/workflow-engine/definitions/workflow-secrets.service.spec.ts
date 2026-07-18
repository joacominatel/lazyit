// SecretService imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports
// jest can't resolve) + the pg adapter. Stub both; the DB is faked with jest.fn()s below.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { NotFoundException } from '@nestjs/common';
import { WorkflowSecretsService } from './workflow-secrets.service';
import {
  SecretService,
  WORKFLOW_SECRET_KEY_ENV,
} from '../secrets/secret.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * #1069 — WorkflowSecretsService.rotate/softDelete used to wrap every SecretService failure in a bare
 * `catch {}` and rethrow a 404, indistinguishable from a genuine DB/crypto error. These two methods now
 * delegate straight through: SecretService itself throws the (distinguishable) NotFoundException for a
 * missing id, and anything else propagates unchanged.
 */

const TEST_KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('WorkflowSecretsService — rotate/softDelete error mapping (#1069)', () => {
  const originalKey = process.env[WORKFLOW_SECRET_KEY_ENV];

  beforeAll(() => {
    process.env[WORKFLOW_SECRET_KEY_ENV] = TEST_KEY_HEX;
  });
  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env[WORKFLOW_SECRET_KEY_ENV];
    } else {
      process.env[WORKFLOW_SECRET_KEY_ENV] = originalKey;
    }
  });

  /** A REAL SecretService over a fake Prisma that always reports "no row updated" (missing id). */
  function serviceOverMissingRow(): WorkflowSecretsService {
    const prisma = {
      workflowSecret: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const secrets = new SecretService(prisma);
    return new WorkflowSecretsService(prisma, secrets);
  }

  it('rotate on a missing id still 404s', async () => {
    const service = serviceOverMissingRow();
    await expect(service.rotate('nope', 'new-value')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('softDelete on a missing id still 404s', async () => {
    const service = serviceOverMissingRow();
    await expect(service.softDelete('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rotate does NOT collapse a non-not-found (DB) error into a 404', async () => {
    const dbError = new Error('Connection terminated unexpectedly');
    const secrets = {
      rotate: jest.fn().mockRejectedValue(dbError),
    } as unknown as SecretService;
    const service = new WorkflowSecretsService({} as PrismaService, secrets);
    await expect(service.rotate('id-1', 'value')).rejects.toBe(dbError);
  });

  it('softDelete does NOT collapse a non-not-found (DB) error into a 404', async () => {
    const dbError = new Error('Connection terminated unexpectedly');
    const secrets = {
      softDelete: jest.fn().mockRejectedValue(dbError),
    } as unknown as SecretService;
    const service = new WorkflowSecretsService({} as PrismaService, secrets);
    await expect(service.softDelete('id-1')).rejects.toBe(dbError);
  });
});
