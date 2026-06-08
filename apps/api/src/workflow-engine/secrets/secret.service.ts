import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CreateWorkflowSecret } from '@lazyit/shared';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SecretService — the engine's OWN encrypted credential store (ADR-0054 §5,
 * `docs/workflow-engine/security.md` §2). AES-256-GCM at rest over the `WorkflowSecret` model.
 *
 * Deliberately a SEPARATE crypto path + key axis from the Settings `SystemSecret` store (ADR-0054
 * decision §5): one key per subsystem, no cross-coupling to the settings module's lifecycle.
 *
 * Security posture (INV-6, ADR-0031):
 *  - The cleartext is NEVER persisted and NEVER returned by any CRUD helper — the write-only API
 *    shape (the {@link WorkflowSecretDescriptor} confirms only that a credential is `configured`).
 *  - {@link reveal} / {@link revealById} are INTERNAL ONLY — for a handler to authenticate at call
 *    time, in memory. They must NEVER be exposed across an API boundary (that's a 1b-B controller
 *    concern, and it returns the redacted descriptor, never this).
 *  - Nothing here logs a secret value; on a decrypt failure the error message carries no plaintext.
 *
 * Key management: the 32-byte key comes from `WORKFLOW_SECRET_KEY` (hex / base64 / raw-utf8 — must
 * decode to exactly 32 bytes). The service FAILS LOUD at boot ({@link onModuleInit}) if the key is
 * missing or the wrong length — a half-configured secret store is worse than an absent one. Losing the
 * key = losing every stored credential (recoverable only by re-entering them — see the backups
 * runbook). The `keyVersion` stamped on every envelope enables a future rotation without re-reading
 * plaintext; v1 ships a single key (version {@link CURRENT_KEY_VERSION}).
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96-bit IV — the GCM-recommended size; a fresh random IV per value. */
const IV_BYTES = 12;
/** The key version stamped on new envelopes. Bump + add a key entry to rotate (future). */
export const CURRENT_KEY_VERSION = 1;
/** The env var the 32-byte master key is read from. */
export const WORKFLOW_SECRET_KEY_ENV = 'WORKFLOW_SECRET_KEY';

/** The AES-256-GCM at-rest envelope produced by {@link SecretService.encrypt}. All text columns. */
export interface SecretEnvelope {
  /** base64 ciphertext. */
  ciphertext: string;
  /** base64 random IV. */
  iv: string;
  /** base64 GCM auth tag. */
  authTag: string;
  /** Which key version produced this envelope. */
  keyVersion: number;
}

/** The minimal envelope shape {@link SecretService.reveal} needs (a `WorkflowSecret` row satisfies it). */
export type SecretEnvelopeInput = SecretEnvelope;

/**
 * The REDACTED, write-only read shape of a stored secret (INV-6) — mirrors the shared
 * `WorkflowSecretSchema`. NEVER carries ciphertext / IV / auth tag / cleartext. Dates are `Date`
 * objects; a 1b-B controller serializes to ISO on the wire.
 */
export interface WorkflowSecretDescriptor {
  id: string;
  applicationId: string;
  connectionId: string | null;
  label: string;
  keyVersion: number;
  /** Always true — its presence is the "a credential is configured" signal. */
  configured: true;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Resolve + validate the 32-byte master key from `WORKFLOW_SECRET_KEY`. Accepts (in order): a 64-char
 * hex string, a base64 string, or a raw utf8 string — each must decode to EXACTLY 32 bytes. Throws a
 * loud, non-secret error otherwise. Exported for the boot check + tests.
 */
export function resolveWorkflowSecretKey(): Buffer {
  const raw = process.env[WORKFLOW_SECRET_KEY_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${WORKFLOW_SECRET_KEY_ENV} is not set — the workflow engine secret store requires a 32-byte key ` +
        `(generate one with: openssl rand -hex 32).`,
    );
  }

  // 1) Hex (64 chars → 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // 2) base64 / base64url decoding to exactly 32 bytes.
  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === KEY_BYTES) {
    return asBase64;
  }
  // 3) Raw utf8 of exactly 32 bytes.
  const asUtf8 = Buffer.from(raw, 'utf8');
  if (asUtf8.length === KEY_BYTES) {
    return asUtf8;
  }

  throw new Error(
    `${WORKFLOW_SECRET_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes ` +
      `(64 hex chars, base64 of 32 bytes, or a 32-char raw string). ` +
      `Generate one with: openssl rand -hex 32.`,
  );
}

@Injectable()
export class SecretService implements OnModuleInit {
  private readonly logger = new Logger(SecretService.name);
  /** The resolved master key, cached after first use (never logged). */
  private key: Buffer | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Fail loud at boot if the encryption key is missing / wrong length (ADR-0054 §5). */
  onModuleInit(): void {
    // Resolving the key validates it; a failure here aborts boot with a clear, non-secret message.
    this.getKey();
    this.logger.log(
      `Workflow secret store ready (AES-256-GCM, key version ${CURRENT_KEY_VERSION}).`,
    );
  }

  /** Lazily resolve + cache the validated master key. Throws (loud, non-secret) on a bad key. */
  private getKey(): Buffer {
    if (!this.key) {
      this.key = resolveWorkflowSecretKey();
    }
    return this.key;
  }

  // ---------- crypto core ----------------------------------------------------

  /**
   * Encrypt a cleartext credential into an at-rest {@link SecretEnvelope} (fresh random IV per value).
   * The cleartext is consumed in memory only — never persisted or returned by any CRUD helper.
   */
  encrypt(plaintext: string): SecretEnvelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.getKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  /**
   * Decrypt an envelope back to its cleartext — INTERNAL ONLY (for a handler to authenticate). GCM
   * verifies the auth tag, so any tampering with the ciphertext / IV / tag throws. The thrown error
   * carries NO plaintext. NEVER expose this across an API boundary.
   */
  reveal(envelope: SecretEnvelopeInput): string {
    if (envelope.keyVersion !== CURRENT_KEY_VERSION) {
      throw new Error(
        `Cannot decrypt workflow secret: unknown key version ${envelope.keyVersion} ` +
          `(current is ${CURRENT_KEY_VERSION}).`,
      );
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.getKey(),
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // Authentication failed (tamper) or a wrong key — never leak the payload in the message.
      throw new Error(
        'Failed to decrypt workflow secret (authentication failed or wrong key).',
      );
    }
  }

  // ---------- write-only CRUD (never returns cleartext / ciphertext) ---------

  /**
   * Create (set) a secret: encrypt the cleartext `value` and persist only the envelope. Returns the
   * REDACTED descriptor — never the cleartext or ciphertext.
   */
  async create(input: CreateWorkflowSecret): Promise<WorkflowSecretDescriptor> {
    const envelope = this.encrypt(input.value);
    const row = await this.prisma.workflowSecret.create({
      data: {
        applicationId: input.applicationId,
        connectionId: input.connectionId ?? null,
        label: input.label,
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        authTag: envelope.authTag,
        keyVersion: envelope.keyVersion,
      },
    });
    return toDescriptor(row);
  }

  /**
   * Rotate a live secret's value in place: re-encrypt under the current key (fresh IV) and overwrite
   * the envelope. Only rotates a non-deleted secret. Returns the REDACTED descriptor.
   */
  async rotate(id: string, value: string): Promise<WorkflowSecretDescriptor> {
    const envelope = this.encrypt(value);
    const result = await this.prisma.workflowSecret.updateMany({
      where: { id, deletedAt: null },
      data: {
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        authTag: envelope.authTag,
        keyVersion: envelope.keyVersion,
      },
    });
    if (result.count === 0) {
      throw new Error(`Workflow secret ${id} not found (or already deleted).`);
    }
    const row = await this.prisma.workflowSecret.findFirstOrThrow({
      where: { id },
    });
    return toDescriptor(row);
  }

  /** Soft-delete (revoke) a secret. A revoked secret can no longer be revealed for authentication. */
  async softDelete(id: string): Promise<void> {
    const result = await this.prisma.workflowSecret.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new Error(`Workflow secret ${id} not found (or already deleted).`);
    }
  }

  // ---------- internal reveal-by-id (for handlers via ctx.revealSecret) ------

  /**
   * Load a LIVE (non-deleted) secret by id and return its cleartext — INTERNAL ONLY. The CORE wires
   * this into a `StepContext.revealSecret` accessor so a handler authenticates at call time. NEVER
   * returned across an API boundary. Throws if the secret is absent / deleted / undecryptable.
   */
  async revealById(id: string): Promise<string> {
    const row = await this.prisma.workflowSecret.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new Error(`Workflow secret ${id} not found (or deleted).`);
    }
    return this.reveal(row);
  }
}

/** Map a `WorkflowSecret` row to the redacted descriptor (drops the envelope columns entirely). */
function toDescriptor(row: {
  id: string;
  applicationId: string;
  connectionId: string | null;
  label: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): WorkflowSecretDescriptor {
  return {
    id: row.id,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    label: row.label,
    keyVersion: row.keyVersion,
    configured: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
