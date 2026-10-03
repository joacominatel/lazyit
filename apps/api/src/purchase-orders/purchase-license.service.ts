import { BadRequestException, Injectable } from '@nestjs/common';
import {
  INT4_MAX,
  type ApplyLicense,
  type LicenseApplication,
  type LicenseApplyWarning,
  type UpdateApplication,
} from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { ApplicationsService } from '../applications/applications.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { recordPurchaseOrderEvent } from './purchase-order-events';
import { assertLicenseLine } from './purchase-order-line-receipt';

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

/** The seats a line still expects: quantity − cancelled, floored at 0. */
const expectedSeats = (line: { quantity: number; cancelledQuantity: number }) =>
  Math.max(line.quantity - line.cancelledQuantity, 0);

/**
 * `LICENSE` purchase lines (ADR-0099 §2, #1477). A license line links to an application and PROPOSES a seats
 * / renewal update; a person confirms it. `Application.seatsPurchased` is one mutable number, not a ledger
 * (ADR-0088), so lazyit never re-derives it: the apply adds the seats the
 * person chose, once, and the line records how many it added (`appliedSeats`, its received units). Applying
 * more than the line bought is allowed and flagged, like an over-received line (ADR-0099 §4).
 */
@Injectable()
export class PurchaseLicenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly purchases: PurchaseOrdersService,
    private readonly applications: ApplicationsService,
  ) {}

  /**
   * What applying the line would do (a read): the application's current seats and renewal, the line's
   * pending seats as the default to add, and what the count would read afterwards. Writes nothing.
   */
  async proposal(purchaseOrderId: string, lineId: string) {
    const { line } = await this.purchases.assertLineLive(
      this.prisma,
      purchaseOrderId,
      lineId,
    );
    assertLicenseLine(line);
    const wire = await this.purchases.readLine(this.prisma, lineId);
    const warnings: LicenseApplyWarning[] = [];
    const application = await this.licenseApplication(line.applicationId);
    if (!application) warnings.push('NO_APPLICATION');
    else if (application.deletedAt !== null)
      warnings.push('APPLICATION_ARCHIVED');
    else if (application.seatsPurchased === null)
      warnings.push('SEATS_UNTRACKED');
    const seatsToAdd = wire.pendingQuantity;
    if (seatsToAdd === 0) warnings.push('NOTHING_PENDING');
    const overAppliedAfter =
      wire.receivedQuantity + seatsToAdd > expectedSeats(line);
    if (overAppliedAfter) warnings.push('OVER_APPLIED');
    const after =
      application && application.deletedAt === null
        ? (application.seatsPurchased ?? 0) + seatsToAdd
        : null;
    return {
      line: wire,
      application,
      seatsToAdd,
      seatsPurchasedAfter: after === null || after > INT4_MAX ? null : after,
      overAppliedAfter,
      warnings,
    };
  }

  /**
   * Apply the line to its application — explicit and user-triggered, never automatic. One transaction, locks
   * in the purchase-write order: the purchase `FOR KEY SHARE` (what a link takes, so a kind change or a line
   * removal serializes with it), the line `FOR UPDATE` (two applies cannot both read the same applied
   * count), then the application `FOR UPDATE` (the seat arithmetic reads the committed count). The
   * application changes through `ApplicationsService.update`, the same path as its own edit form; the line's
   * `appliedSeats` and the purchase's `LICENSE_APPLIED` event commit with it.
   */
  async apply(
    purchaseOrderId: string,
    lineId: string,
    data: ApplyLicense,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "purchase_orders" WHERE "id" = ${purchaseOrderId} FOR KEY SHARE`;
      await this.purchases.assertLineLive(tx, purchaseOrderId, lineId);
      await tx.$queryRaw`SELECT "id" FROM "purchase_order_lines" WHERE "id" = ${lineId} FOR UPDATE`;
      // Re-read under the lock: the kind, the application and the applied count are the committed ones.
      const line = await tx.purchaseOrderLine.findFirstOrThrow({
        where: { id: lineId },
      });
      assertLicenseLine(line);
      if (!line.applicationId) {
        throw new BadRequestException(
          'This line has no application. Map the line to an application (PATCH the line with applicationId) before applying it',
        );
      }
      await tx.$queryRaw`SELECT "id" FROM "applications" WHERE "id" = ${line.applicationId} FOR UPDATE`;
      const application = await tx.application.findFirst({
        where: { id: line.applicationId, deletedAt: null },
      });
      if (!application) {
        throw new BadRequestException(
          `This line's application ${line.applicationId} is archived. Restore it, or map the line to another application`,
        );
      }

      const warnings: LicenseApplyWarning[] = [];
      const update: UpdateApplication = {};
      let seatsPurchased: { from: number | null; to: number } | null = null;
      if (data.seatsToAdd !== undefined) {
        if (application.seatsPurchased === null) {
          warnings.push('SEATS_UNTRACKED');
        }
        const to = (application.seatsPurchased ?? 0) + data.seatsToAdd;
        if (to > INT4_MAX) {
          throw new BadRequestException(
            'The application cannot hold that many seats',
          );
        }
        update.seatsPurchased = to;
        seatsPurchased = { from: application.seatsPurchased, to };
      }
      let renewalDate: { from: string | null; to: string } | null = null;
      if (data.renewalDate !== undefined) {
        update.renewalDate = data.renewalDate;
        renewalDate = {
          from: iso(application.renewalDate),
          to: data.renewalDate,
        };
      }

      const appliedFrom = line.appliedSeats;
      const appliedTo = appliedFrom + (data.seatsToAdd ?? 0);
      if (appliedTo > INT4_MAX) {
        throw new BadRequestException('The line cannot count that many seats');
      }
      const saved = await this.applications.update(application.id, update, tx);
      if (appliedTo !== appliedFrom) {
        await tx.purchaseOrderLine.update({
          where: { id: lineId },
          data: { appliedSeats: appliedTo },
        });
      }
      const overApplied = appliedTo > expectedSeats(line);
      if (overApplied) warnings.push('OVER_APPLIED');
      await recordPurchaseOrderEvent(
        tx,
        purchaseOrderId,
        'LICENSE_APPLIED',
        actor,
        {
          lineId,
          applicationId: application.id,
          seatsAdded: data.seatsToAdd ?? 0,
          seatsPurchased,
          renewalDate,
          appliedSeats: { from: appliedFrom, to: appliedTo },
          overApplied,
        },
      );
      return {
        application: saved,
        line: await this.purchases.readLine(tx, lineId),
        overApplied,
        warnings,
      };
    });
  }

  /**
   * The line's application as the proposal shows it — archived ones included (flagged, `seatsUsed` null),
   * since the link outlives a soft delete. `null` when the line names none.
   */
  private async licenseApplication(
    applicationId: string | null,
  ): Promise<LicenseApplication | null> {
    if (!applicationId) return null;
    const row = await this.prisma.application.findFirst({
      where: { id: applicationId },
      select: {
        id: true,
        name: true,
        seatsPurchased: true,
        renewalDate: true,
        deletedAt: true,
      },
      includeSoftDeleted: true,
    } as Prisma.ApplicationFindFirstArgs);
    if (!row) return null;
    const live = row.deletedAt === null;
    const seatsUsed = live
      ? ((await this.applications.findOne(row.id)).seatsUsed ?? 0)
      : null;
    return {
      id: row.id,
      name: row.name,
      seatsPurchased: row.seatsPurchased,
      seatsUsed,
      renewalDate: iso(row.renewalDate),
      deletedAt: iso(row.deletedAt),
    };
  }
}
