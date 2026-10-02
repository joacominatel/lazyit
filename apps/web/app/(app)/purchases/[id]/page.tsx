import { PurchaseDetailView } from "./_components/purchase-detail-view";

/** /purchases/:id — one purchase (client-fetched; the area is permission-gated). */
export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseDetailView id={id} />;
}
