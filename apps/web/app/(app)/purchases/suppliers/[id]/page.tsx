import { SupplierDetailView } from "./_components/supplier-detail-view";

/** /purchases/suppliers/:id — one supplier and their purchases. */
export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupplierDetailView id={id} />;
}
