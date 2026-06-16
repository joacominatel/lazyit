import { Injectable } from '@nestjs/common';
import type { AssetTagScheme, UpdateAssetTagScheme } from '@lazyit/shared';
import { renderAssetTag } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AssetTagSchemeService — the brain behind lazyit's first instance-config entity (ADR-0063, #363):
 * the org-wide, single-row, OPT-IN scheme that auto-assigns a running asset tag on create.
 *
 * Two responsibilities:
 *   1. The config surface (`GET`/`PUT /config/asset-tag-scheme`) — read the single row (or its
 *      explicit unset/disabled default) and upsert it.
 *   2. The in-create allocation (`allocateTag`) — when the scheme is ENABLED and the caller did not
 *      pass an explicit tag, atomically allocate the next rendered tag, retrying on a live-tag
 *      collision (P2002 against `assets_assetTag_active_key`, ADR-0041). Gaps are accepted.
 */
@Injectable()
export class AssetTagSchemeService {
  /**
   * The fixed singleton primary key (ADR-0063 §1). The instance has exactly ONE scheme row; a
   * migration CHECK pins the id to this literal, so every read/upsert targets the same row and a
   * second row is structurally impossible.
   */
  static readonly SINGLETON_ID = 'singleton';

  /**
   * Bounded retry on a tag collision (ADR-0063 §3). Each attempt consumes a fresh, DURABLY-committed
   * counter value (so a clash advances the sequence — gaps accepted, never an infinite re-collision).
   * 50 is generous: a collision only happens when a MANUAL tag already took the formula's value, which
   * is rare; exhausting 50 means the manual estate densely occupies the sequence and is a real 409.
   */
  static readonly MAX_ALLOCATION_ATTEMPTS = 50;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the scheme for the config surface. Returns the explicit UNSET/DISABLED default (enabled
   * false, no affixes, the would-be next number 1) when no row has ever been written — so the
   * frontend always receives a concrete shape, never a 404 for "unset" (ADR-0063 §4).
   */
  async getScheme(): Promise<AssetTagScheme> {
    const row = await this.prisma.assetTagScheme.findFirst({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
    });
    if (!row) {
      const now = new Date();
      return {
        prefix: null,
        suffix: null,
        width: null,
        nextNumber: 1,
        enabled: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }
    return this.toWire(row);
  }

  /**
   * Upsert the single config row (`PUT`). `enabled`/`prefix`/`suffix`/`width` are set wholesale.
   * `startNumber`, when present, (re)seeds the counter to that NEXT value (e.g. start at 1000); when
   * omitted the counter is left untouched on update and defaults to 1 on first create — so toggling
   * `enabled` never rewinds the sequence (ADR-0063 §1/§4). The shared zod schema already guarantees a
   * sequence is structurally present (no `{num}`-less config is representable), so there is nothing to
   * reject here beyond what validation caught.
   */
  async updateScheme(input: UpdateAssetTagScheme): Promise<AssetTagScheme> {
    // prefix/suffix arrive as `string | undefined`; persist `undefined` as SQL NULL (clear the affix).
    const prefix = input.prefix ?? null;
    const suffix = input.suffix ?? null;
    const width = input.width ?? null;
    const row = await this.prisma.assetTagScheme.upsert({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
      create: {
        id: AssetTagSchemeService.SINGLETON_ID,
        enabled: input.enabled,
        prefix,
        suffix,
        width,
        // On first create, seed the counter from startNumber (default 1 when omitted).
        nextNumber: input.startNumber ?? 1,
      },
      update: {
        enabled: input.enabled,
        prefix,
        suffix,
        width,
        // Only re-seed the counter when startNumber was explicitly supplied; otherwise leave it.
        ...(input.startNumber !== undefined
          ? { nextNumber: input.startNumber }
          : {}),
      },
    });
    return this.toWire(row);
  }

  /**
   * Allocate the auto-assigned tag for a NEW asset, or return `undefined` to fall through to today's
   * behaviour (ADR-0063 §3/§4). Returns `undefined` — meaning "do not set an auto-tag" — when:
   *   - the caller passed an explicit `assetTag` (the explicit value ALWAYS wins), or
   *   - no scheme is configured, or the scheme is disabled (OFF by default).
   *
   * Otherwise it atomically consumes the next counter value and renders `prefix + zeroPad + suffix`.
   * If the rendered tag collides with an existing LIVE tag (a manual tag took that value — P2002 on
   * `assets_assetTag_active_key`) the asset insert will reject; the CALLER retries by calling this
   * again, which advances to the next number (gaps accepted). We probe for an existing live tag here
   * to skip an attempt cheaply, but the asset-insert P2002 remains the authoritative collision guard.
   *
   * CONCURRENCY (ADR-0063 §3): the increment is a single atomic `update ... { increment: 1 }` that
   * COMMITS on its own — two concurrent creates therefore read different numbers and never collide.
   * It is deliberately NOT folded into the asset-create `$transaction`: if it were, a rolled-back
   * asset insert would un-consume the number, so a retry would re-render the SAME colliding tag
   * forever. Committing the increment independently makes each consumed value durable, which is
   * exactly what "gaps accepted" requires and what lets a collision ADVANCE rather than spin.
   */
  async allocateTag(explicitTag: string | undefined): Promise<string | undefined> {
    if (explicitTag !== undefined) {
      return undefined; // explicit tag wins — never auto-allocate over it.
    }
    const scheme = await this.prisma.assetTagScheme.findFirst({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
    });
    if (!scheme || !scheme.enabled) {
      return undefined; // OFF by default — the create path is byte-for-byte unchanged.
    }
    // Atomically consume the next number (durably committed) and render the tag.
    const updated = await this.prisma.assetTagScheme.update({
      where: { id: AssetTagSchemeService.SINGLETON_ID },
      data: { nextNumber: { increment: 1 } },
    });
    // `updated.nextNumber` is the value AFTER the increment, so the value we allocated is `-1`.
    const allocated = updated.nextNumber - 1;
    return renderAssetTag(
      { prefix: scheme.prefix, suffix: scheme.suffix, width: scheme.width },
      allocated,
    );
  }

  /** Map the Prisma row to the wire shape (Dates -> ISO strings). */
  private toWire(row: {
    prefix: string | null;
    suffix: string | null;
    width: number | null;
    nextNumber: number;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): AssetTagScheme {
    return {
      prefix: row.prefix,
      suffix: row.suffix,
      width: row.width,
      nextNumber: row.nextNumber,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Type guard for the live-tag unique collision (P2002 on `assets_assetTag_active_key`). */
export function isUniqueTagCollision(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
