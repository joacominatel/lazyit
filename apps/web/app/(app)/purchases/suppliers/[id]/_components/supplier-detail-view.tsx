"use client";

import { ArrowsPointingInIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePurchaseOrders } from "@/lib/api/hooks/use-purchase-orders";
import { useDeleteSupplier, useSupplier } from "@/lib/api/hooks/use-suppliers";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  MoneyTotals,
  PurchaseStatusBadge,
  ReceiptSummary,
  usePurchaseTitle,
} from "../../../_components/purchase-display";
import { SupplierFormDialog } from "../../_components/supplier-form-dialog";
import { MergeSupplierDialog } from "./merge-supplier-dialog";

/** How many of the supplier's purchases the page lists before linking to the full, filtered list. */
const PURCHASES_SHOWN = 20;

/**
 * A stored website → a link target: http(s) as is, a scheme-less host as `https://…`. Anything with
 * another scheme is not linked (the write schema refuses it; this keeps the read side safe regardless).
 */
function websiteHref(website: string): string | null {
  if (/^https?:\/\//i.test(website)) return website;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(website)) return null; // a host:port is not a scheme
  return `https://${website}`;
}

/** One contact block: name, email (mailto) and phone, or "—". */
function Contact({ name, email, phone }: { name: string | null; email: string | null; phone: string | null }) {
  if (!name && !email && !phone) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5 text-sm">
      {name ? <p>{name}</p> : null}
      {email ? (
        <p>
          <a href={`mailto:${email}`} className="hover:underline">
            {email}
          </a>
        </p>
      ) : null}
      {phone ? <p className="font-mono">{phone}</p> : null}
    </div>
  );
}

/** One supplier (ADR-0099 §2): identity, sales and support contacts, notes, and their purchases. */
export function SupplierDetailView({ id }: { id: string }) {
  const t = useTranslations("purchases.suppliers");
  const tPurchases = useTranslations("purchases");
  const tc = useTranslations("common");
  const router = useRouter();
  const { date } = useFormatters();
  const titleOf = usePurchaseTitle();
  const canWrite = useCan("purchaseOrder:write");
  const canDelete = useCan("purchaseOrder:delete");
  const { data: supplier, isLoading, isError, error, refetch } = useSupplier(id);
  const { data: purchases } = usePurchaseOrders({ supplierId: id, limit: PURCHASES_SHOWN });
  const deleteSupplier = useDeleteSupplier();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tPurchases("list.title"), href: "/purchases" },
          { label: tPurchases("area.suppliers"), href: "/purchases/suppliers" },
          { label: supplier?.name ?? "" },
        ]}
      />
    ),
    [tPurchases, supplier?.name],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }
  if (isError || !supplier) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={supplier.name}
        subtitle={supplier.taxId ? <span className="font-mono">{supplier.taxId}</span> : undefined}
        actions={
          canWrite || canDelete ? (
            <>
              {canWrite ? (
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <PencilSquareIcon />
                  {tc("edit")}
                </Button>
              ) : null}
              {canDelete ? (
                <Button variant="outline" size="sm" onClick={() => setMergeOpen(true)}>
                  <ArrowsPointingInIcon />
                  {t("merge.action")}
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("archive")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title={t("detail.detailsSection")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("form.taxId")} mono>
            {supplier.taxId ?? "—"}
          </DetailField>
          <DetailField label={t("form.website")}>
            {supplier.website && websiteHref(supplier.website) ? (
              <a
                href={websiteHref(supplier.website) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                {supplier.website}
              </a>
            ) : (
              (supplier.website ?? "—")
            )}
          </DetailField>
          <DetailField label={t("form.salesContact")}>
            <Contact
              name={supplier.salesContactName}
              email={supplier.salesContactEmail}
              phone={supplier.salesContactPhone}
            />
          </DetailField>
          <DetailField label={t("form.supportContact")}>
            <Contact
              name={supplier.supportContactName}
              email={supplier.supportContactEmail}
              phone={supplier.supportContactPhone}
            />
          </DetailField>
        </dl>
        {supplier.notes ? (
          <dl className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">{t("form.notes")}</dt>
            <dd className="text-sm whitespace-pre-wrap">{supplier.notes}</dd>
          </dl>
        ) : null}
      </DetailPanel>

      <DetailPanel
        title={t("detail.purchasesSection")}
        actions={
          (purchases?.total ?? 0) > PURCHASES_SHOWN ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/purchases?supplier=${supplier.id}&receipt=ALL`}>
                {t("detail.allPurchases", { count: purchases?.total ?? 0 })}
              </Link>
            </Button>
          ) : undefined
        }
      >
        {(purchases?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noPurchases")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tPurchases("list.columns.purchase")}</TableHead>
                  <TableHead>{tPurchases("list.columns.ordered")}</TableHead>
                  <TableHead>{tPurchases("list.columns.status")}</TableHead>
                  <TableHead>{tPurchases("list.columns.received")}</TableHead>
                  <TableHead>{tPurchases("list.columns.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(purchases?.items ?? []).map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell className="font-medium">
                      <Link href={`/purchases/${purchase.id}`} className="hover:underline">
                        {titleOf(purchase)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground tabular-nums">
                      {purchase.orderDate ? date(purchase.orderDate) : "—"}
                    </TableCell>
                    <TableCell>
                      <PurchaseStatusBadge status={purchase.status} receipt={purchase.receipt} />
                    </TableCell>
                    <TableCell className="text-sm">
                      <ReceiptSummary receipt={purchase.receipt} />
                    </TableCell>
                    <TableCell className="text-sm">
                      <MoneyTotals totals={purchase.totals} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DetailPanel>

      <SupplierFormDialog open={editOpen} onOpenChange={setEditOpen} supplier={supplier} />
      {canDelete ? (
        <MergeSupplierDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          source={supplier}
          onMerged={(kept) => router.push(`/purchases/suppliers/${kept.id}`)}
        />
      ) : null}
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="supplier"
        name={supplier.name}
        onConfirm={() => deleteSupplier.mutateAsync(supplier.id)}
        onDeleted={() => router.push("/purchases/suppliers")}
      >
        {t("archiveNote")}
      </DeleteConfirmDialog>
    </div>
  );
}
