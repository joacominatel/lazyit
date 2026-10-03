import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PURCHASE_ORDER_SEARCH_SELECT,
  projectPurchaseOrder,
  projectSupplier,
} from './search.documents';
import { SearchService } from './search.service';

/**
 * Write-path search sync for purchases and suppliers (#1499, ADR-0035 / ADR-0099).
 *
 * A purchase document joins its supplier's name and its live lines' descriptions, so it changes on writes
 * the purchase service does not hold the full row for (a line edit, a supplier rename). Instead of every
 * call site assembling the document, each committed write names the record and this re-reads it from the
 * database: a live row is upserted, an archived or missing one is removed. That one rule covers create,
 * update, archive, restore and line changes alike.
 *
 * Fire-and-forget like every search sync: the methods return at once, never throw, and a failed read or
 * engine call is logged and left to the next write or the reconcile sweeper. No-op when search is
 * disabled. Call it AFTER the transaction commits, never inside it — a rolled-back write must not reach
 * the index, and the re-read must see the committed row.
 */
@Injectable()
export class PurchaseSearchSync {
  private readonly logger = new Logger(PurchaseSearchSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
  ) {}

  /** Re-project one purchase: upsert when live, remove when archived or gone. */
  purchase(id: string): void {
    if (!this.search.enabled) return;
    void this.run('purchase', id, () => this.syncPurchase(id));
  }

  /**
   * Re-project one supplier — upsert when live, remove when archived or gone — and, unless `purchases` is
   * false, every live purchase that names it, so a rename reaches the purchases' `supplierName`. Pass
   * `purchases: false` when the write cannot change what a purchase document holds: a create (no purchases
   * yet), an archive or restore (an archived supplier keeps its name on its purchases), an edit that leaves
   * the name alone. A supplier merge (#1496) re-projects the kept supplier with its purchases (the moved
   * ones included) and removes the archived duplicate.
   */
  supplier(
    id: string,
    { purchases = true }: { purchases?: boolean } = {},
  ): void {
    if (!this.search.enabled) return;
    void this.run('supplier', id, () => this.syncSupplier(id, { purchases }));
  }

  /** The awaitable pass behind {@link purchase}, for the tests. */
  async syncPurchase(id: string): Promise<void> {
    const row = await this.prisma.purchaseOrder.findFirst({
      where: { id, deletedAt: null },
      select: PURCHASE_ORDER_SEARCH_SELECT,
    });
    if (row) this.search.upsert('purchases', projectPurchaseOrder(row));
    else this.search.remove('purchases', id);
  }

  /** The awaitable pass behind {@link supplier}, for the tests. */
  async syncSupplier(
    id: string,
    { purchases = true }: { purchases?: boolean } = {},
  ): Promise<void> {
    const row = await this.prisma.supplier.findFirst({
      where: { id, deletedAt: null },
    });
    if (row) this.search.upsert('suppliers', projectSupplier(row));
    else this.search.remove('suppliers', id);

    if (!purchases) return;
    // An archived supplier keeps its name on its purchases (the purchase page still shows it), so its
    // purchases are re-projected whether it is live or not.
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { supplierId: id, deletedAt: null },
      select: PURCHASE_ORDER_SEARCH_SELECT,
    });
    this.search.upsertMany('purchases', rows.map(projectPurchaseOrder));
  }

  private async run(
    kind: 'purchase' | 'supplier',
    id: string,
    pass: () => Promise<void>,
  ): Promise<void> {
    try {
      await pass();
    } catch (err) {
      this.logger.error(
        `Dropped search sync for ${kind} ${id} (stale until its next write or the reconcile sweep): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
