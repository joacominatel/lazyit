import { ExtractionReviewView } from "./_components/extraction-review-view";

/**
 * /purchases/:id/review/:attachmentId — the reviewed draft read from one of the purchase's documents (ADR-0099
 * §11, #1477). Client-fetched like the purchase page; `?read=1` asks for the read once, on arrival.
 */
export default async function PurchaseDocumentReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; attachmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id, attachmentId }, query] = await Promise.all([params, searchParams]);
  return <ExtractionReviewView purchaseId={id} attachmentId={attachmentId} autoRead={query.read === "1"} />;
}
