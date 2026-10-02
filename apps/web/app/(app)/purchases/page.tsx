import { PurchasesListView } from "./_components/purchases-list-view";

/**
 * /purchases — the purchases list (ADR-0099). Client-fetched: the area is permission-gated
 * (`purchaseOrder:read`), so a server prefetch would only warm the cache for callers who may read it.
 */
export default function PurchasesPage() {
  return <PurchasesListView />;
}
