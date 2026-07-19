import { Injectable } from '@nestjs/common';
import type {
  DirectoryConnection,
  DirectorySyncCounts,
  DirectoryTransport,
  UpdateDirectoryConnection,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DIRECTORY_CONNECTION_SINGLETON_ID } from './directory.constants';
import { decryptBindPassword, encryptBindPassword } from './directory.crypto';
import type { ResolvedDirectoryConfig } from './directory-ldap.client';

/** The DirectoryConnection Prisma row shape this service maps (kept explicit for the redaction helper). */
type DirectoryConnectionRow = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  transport: string;
  rejectUnauthorized: boolean;
  baseDN: string | null;
  bindDN: string | null;
  searchFilter: string | null;
  attributeMap: Prisma.JsonValue | null;
  offboardGraceDays: number;
  bindPasswordCiphertext: string | null;
  bindPasswordIv: string | null;
  bindPasswordAuthTag: string | null;
  bindPasswordKeyVersion: number | null;
  serviceAccountId: string | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncCounts: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * DirectoryConnectionService — the singleton instance-config store for the on-prem AD/LDAP directory
 * source (issue #839, ADR-0091), the same shape as SmtpService/AssetTagSchemeService (ADR-0063/0079): read
 * the single row (or an explicit disabled default) and upsert it. Also resolves the in-memory bind config
 * (decrypting the at-rest bind password) for the reconcile, and caches the last run's status/counts.
 *
 * The bind password is WRITE-ONLY: {@link getSettings} never returns it (only `bindPasswordSet`); it leaves
 * this service only as an LDAP bind credential to AD.
 */
@Injectable()
export class DirectoryConnectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read the config for the settings surface — an explicit DISABLED default when no row exists (never 404). */
  async getSettings(): Promise<DirectoryConnection> {
    const row = await this.prisma.directoryConnection.findFirst({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
    });
    if (!row) {
      const now = new Date().toISOString();
      return {
        enabled: false,
        host: null,
        port: null,
        transport: 'ldaps',
        rejectUnauthorized: true,
        baseDN: null,
        bindDN: null,
        searchFilter: null,
        attributeMap: null,
        offboardGraceDays: 7,
        bindPasswordSet: false,
        serviceAccountId: null,
        lastSyncAt: null,
        lastSyncStatus: 'never',
        lastSyncCounts: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.toWire(row);
  }

  /**
   * Upsert the single config row (`PUT`). Fields are set wholesale. The BIND PASSWORD is write-only: a
   * non-empty value is encrypted (AES-256-GCM under DIRECTORY_SECRET_KEY) and stored; omitted/empty leaves
   * the stored envelope. Encrypting throws {@link DirectorySecretKeyMissingError} (mapped to 409 at the
   * controller) if the master key is unset — the rest of the config still saves. Returns the redacted config.
   */
  async updateSettings(
    input: UpdateDirectoryConnection,
  ): Promise<DirectoryConnection> {
    const base = {
      enabled: input.enabled,
      host: input.host ?? null,
      port: input.port ?? null,
      transport: input.transport,
      rejectUnauthorized: input.rejectUnauthorized,
      baseDN: input.baseDN ?? null,
      bindDN: input.bindDN ?? null,
      searchFilter: input.searchFilter ?? null,
      attributeMap:
        input.attributeMap === undefined || input.attributeMap === null
          ? Prisma.JsonNull
          : (input.attributeMap as Prisma.InputJsonValue),
      offboardGraceDays: input.offboardGraceDays,
      serviceAccountId: input.serviceAccountId ?? null,
    };
    // Encrypt only when a non-empty password was supplied (set/rotate); otherwise leave the envelope.
    const envelope =
      input.bindPassword && input.bindPassword.length > 0
        ? encryptBindPassword(input.bindPassword)
        : null;
    const envelopeData = envelope
      ? {
          bindPasswordCiphertext: envelope.ciphertext,
          bindPasswordIv: envelope.iv,
          bindPasswordAuthTag: envelope.authTag,
          bindPasswordKeyVersion: envelope.keyVersion,
        }
      : {};

    const row = await this.prisma.directoryConnection.upsert({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
      create: {
        id: DIRECTORY_CONNECTION_SINGLETON_ID,
        ...base,
        ...envelopeData,
      },
      update: {
        ...base,
        ...envelopeData,
      },
    });
    return this.toWire(row);
  }

  /**
   * Resolve the in-memory bind config (INTERNAL). Reads the row, requires the minimum to sync (host + port
   * + baseDN + searchFilter), and decrypts the bind password if one is stored. Returns null when the config
   * is incomplete or (when `requireEnabled`) disabled — the caller treats null as "don't sync". The
   * decrypted password lives only in the returned object (never logged/persisted).
   */
  async resolveConfig(
    requireEnabled: boolean,
  ): Promise<ResolvedDirectoryConfig | null> {
    const row = await this.prisma.directoryConnection.findFirst({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
    });
    if (!row) return null;
    if (requireEnabled && !row.enabled) return null;
    if (!row.host || !row.port || !row.baseDN || !row.searchFilter) return null;

    let bindPassword: string | null = null;
    if (
      row.bindPasswordCiphertext &&
      row.bindPasswordIv &&
      row.bindPasswordAuthTag &&
      row.bindPasswordKeyVersion != null
    ) {
      bindPassword = decryptBindPassword({
        ciphertext: row.bindPasswordCiphertext,
        iv: row.bindPasswordIv,
        authTag: row.bindPasswordAuthTag,
        keyVersion: row.bindPasswordKeyVersion,
      });
    }

    return {
      host: row.host,
      port: row.port,
      transport: row.transport as DirectoryTransport,
      rejectUnauthorized: row.rejectUnauthorized,
      baseDN: row.baseDN,
      bindDN: row.bindDN,
      bindPassword,
      searchFilter: row.searchFilter,
      attributeNames: attributeNamesOf(row.attributeMap),
    };
  }

  /** Read the offboard grace threshold (days) — the reconcile needs it alongside the resolved bind config. */
  async getOffboardGraceDays(): Promise<number> {
    const row = await this.prisma.directoryConnection.findFirst({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
      select: { offboardGraceDays: true },
    });
    return row?.offboardGraceDays ?? 7;
  }

  /** The optional attribution service-account id (ADR-0048) the reconcile stamps on UserHistory rows. */
  async getServiceAccountId(): Promise<string | null> {
    const row = await this.prisma.directoryConnection.findFirst({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
      select: { serviceAccountId: true },
    });
    return row?.serviceAccountId ?? null;
  }

  /** The RECOGNIZED-key attribute map (profileKey → AD attr name) — the reconcile maps profile columns. */
  async getAttributeMap(): Promise<Record<string, string>> {
    const row = await this.prisma.directoryConnection.findFirst({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
      select: { attributeMap: true },
    });
    return asStringMap(row?.attributeMap ?? null);
  }

  /** Cache the last run's outcome (mirrors UpdateSettings caching) so the UI reads this, not a live sync. */
  async recordRun(
    status: 'ok' | 'error',
    counts: DirectorySyncCounts,
    finishedAt: Date,
  ): Promise<void> {
    await this.prisma.directoryConnection.update({
      where: { id: DIRECTORY_CONNECTION_SINGLETON_ID },
      data: {
        lastSyncAt: finishedAt,
        lastSyncStatus: status,
        lastSyncCounts: counts,
      },
    });
  }

  /** Map the Prisma row to the redacted wire shape — drops the bind-password envelope columns entirely. */
  private toWire(row: DirectoryConnectionRow): DirectoryConnection {
    const counts = asCounts(row.lastSyncCounts);
    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      transport: row.transport as DirectoryTransport,
      rejectUnauthorized: row.rejectUnauthorized,
      baseDN: row.baseDN,
      bindDN: row.bindDN,
      searchFilter: row.searchFilter,
      attributeMap: asStringMapOrNull(row.attributeMap),
      offboardGraceDays: row.offboardGraceDays,
      bindPasswordSet: row.bindPasswordCiphertext != null,
      serviceAccountId: row.serviceAccountId,
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      lastSyncStatus:
        (row.lastSyncStatus as DirectoryConnection['lastSyncStatus']) ?? null,
      lastSyncCounts: counts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** The AD attribute NAMES to fetch = the values of the attribute map (deduped by the caller). */
function attributeNamesOf(map: Prisma.JsonValue | null): string[] {
  return Object.values(asStringMap(map));
}

/** Coerce a jsonb value to a string→string map, dropping any non-string values (defensive). */
function asStringMap(value: Prisma.JsonValue | null): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Like asStringMap but preserves null (for the wire shape, which distinguishes "unset" from "{}"). */
function asStringMapOrNull(
  value: Prisma.JsonValue | null,
): Record<string, string> | null {
  if (value === null) return null;
  return asStringMap(value);
}

/** Coerce a cached lastSyncCounts jsonb to the counts wire shape, or null. */
function asCounts(value: Prisma.JsonValue | null): DirectorySyncCounts | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
  return {
    created: num(v.created),
    updated: num(v.updated),
    offboarded: num(v.offboarded),
    skipped: num(v.skipped),
  };
}
