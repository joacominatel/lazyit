import { PurchaseEditView } from "./_components/purchase-edit-view";

export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseEditView id={id} />;
}
