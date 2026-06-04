"use client";

import { PrinterIcon } from "@heroicons/react/24/outline";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/lib/api/hooks/use-users";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import {
  DEFAULT_OFFBOARDING_MESSAGE,
  DEFAULT_ORG_NAME,
  DEFAULT_SHOW_ACCESS,
  DEFAULT_SHOW_ASSETS,
  OFFBOARDING_MESSAGE_KEY,
  ORG_NAME_KEY,
  SHOW_ACCESS_KEY,
  SHOW_ASSETS_KEY,
} from "@/lib/offboarding/constants";
import { useOffboardingData } from "@/lib/offboarding/use-offboarding-data";
import { formatDate } from "@/lib/utils/format";

/**
 * Offboarding Return Act — the printable, signable document (Wave 3b, issue #172). Lives in the
 * chrome-less `(print)` route group so it prints as a single sheet with no app furniture. It reuses
 * the exact same client-side data resolution as the in-app Offboarding Sheet
 * ({@link useOffboardingData}), so the screen and the paper never disagree about what is returned and
 * revoked.
 *
 * Print styling: an additive `@media print` block in globals.css hides the on-screen "Print" control
 * and sets `@page` margins + a white background. Everything else is plain, high-contrast document
 * markup — a real `☐` checkbox per asset for IT to tick at handover, and ruled signature lines.
 *
 * Edge cases: catalog still loading → skeletons; a user with nothing held → an explicit "Nothing to
 * return"; an asset/app that doesn't resolve in the catalog → its raw id is printed with a verify
 * note (never a crash).
 */
export default function OffboardingActPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: user, isLoading: userLoading, isError } = useUser(id);
  const { assets, grants, isLoading: dataLoading, isEmpty } = useOffboardingData(id);
  const [orgName, , orgMounted] = useLocalStorage(ORG_NAME_KEY, DEFAULT_ORG_NAME);
  const [message, , msgMounted] = useLocalStorage(
    OFFBOARDING_MESSAGE_KEY,
    DEFAULT_OFFBOARDING_MESSAGE,
  );
  // The act lists these sections unless the operator opted out in the offboarding sheet.
  const [showAssets] = useLocalStorage(SHOW_ASSETS_KEY, DEFAULT_SHOW_ASSETS);
  const [showAccess] = useLocalStorage(SHOW_ACCESS_KEY, DEFAULT_SHOW_ACCESS);
  // Snapshot the issue date once so a re-render (or the print dialog) can't shift it.
  const [issuedAt] = useState(() => new Date().toISOString());

  const isLoading = userLoading || dataLoading;
  const org = orgMounted ? orgName : DEFAULT_ORG_NAME;
  const note = msgMounted ? message : DEFAULT_OFFBOARDING_MESSAGE;

  // Name the printed/saved PDF after the person rather than the route path.
  useEffect(() => {
    if (!user) return;
    const previous = document.title;
    document.title = `Return Act — ${user.firstName} ${user.lastName}`;
    return () => {
      document.title = previous;
    };
  }, [user]);

  if (isError) {
    return (
      <main className="mx-auto max-w-2xl px-8 py-16 text-sm text-muted-foreground">
        This user could not be loaded — they may have been removed, or the API is
        unreachable.
      </main>
    );
  }

  return (
    <main
      data-print-document
      className="mx-auto max-w-2xl bg-white px-8 py-10 text-sm text-foreground print:max-w-none print:px-0 print:py-0"
    >
      {/* On-screen print control — hidden when printing (see @media print in globals.css). */}
      <div data-print-hide className="mb-6 flex justify-end">
        <Button size="sm" onClick={() => window.print()}>
          <PrinterIcon />
          Print
        </Button>
      </div>

      {/* Letterhead */}
      <header className="flex items-baseline justify-between border-b border-foreground/20 pb-3">
        <span className="font-heading text-base font-semibold tracking-tight">
          {org}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatDate(issuedAt)}
        </span>
      </header>

      {/* Bilingual title */}
      <div className="mt-6">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Asset Return &amp; Access Acknowledgment
        </h1>
        <p className="mt-0.5 text-muted-foreground">
          Acta de baja y devolución de activos
        </p>
      </div>

      {/* Person block */}
      <section className="mt-6 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        {userLoading || !user ? (
          <>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-48" />
          </>
        ) : (
          <>
            <p>
              <span className="text-muted-foreground">Name: </span>
              {user.firstName} {user.lastName}
            </p>
            <p>
              <span className="text-muted-foreground">Email: </span>
              {user.email}
            </p>
            <p>
              <span className="text-muted-foreground">Role: </span>
              {user.role}
            </p>
          </>
        )}
      </section>

      {/* Return checklist — listed on the act unless toggled off in the offboarding sheet. */}
      {showAssets && (
      <section className="mt-7">
        <h2 className="text-label uppercase text-muted-foreground">
          Assets to return
        </h2>
        {isLoading ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
          </div>
        ) : assets.length === 0 ? (
          <p className="mt-2 text-muted-foreground">Nothing to return.</p>
        ) : (
          <ul className="mt-2 divide-y divide-foreground/10">
            {assets.map((asset) => {
              const title =
                asset.assetTag ??
                asset.name ??
                (asset.resolved ? "Asset" : asset.assetId);
              const meta = [
                asset.serial ? `SN ${asset.serial}` : null,
                asset.model,
                asset.category,
              ].filter(Boolean);
              return (
                <li
                  key={asset.assignmentId}
                  className="flex items-start gap-3 py-2"
                >
                  {/* A drawn checkbox for IT to tick on receipt — a bordered span renders
                      consistently across print drivers where the unicode ☐ glyph does not. */}
                  <span
                    aria-hidden
                    className="mt-0.5 inline-block size-3.5 shrink-0 rounded-[2px] border border-foreground/50"
                  />
                  <div className="min-w-0">
                    <p className="font-medium">{title}</p>
                    {asset.resolved ? (
                      meta.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {meta.join(" · ")}
                        </p>
                      ) : null
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Not in catalog — verify by id {asset.assetId}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {/* Access revoked — listed on the act unless toggled off in the offboarding sheet. */}
      {showAccess && (
      <section className="mt-7">
        <h2 className="text-label uppercase text-muted-foreground">
          Access revoked
        </h2>
        {isLoading ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : grants.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No active application access.</p>
        ) : (
          <ul className="mt-2 divide-y divide-foreground/10">
            {grants.map((grant) => {
              const title =
                grant.appName ??
                (grant.resolved ? "Application" : grant.applicationId);
              const meta = [
                grant.accessLevel,
                grant.isCritical ? "Critical" : null,
                grant.expiresAt ? `expires ${formatDate(grant.expiresAt)}` : null,
              ].filter(Boolean);
              return (
                <li key={grant.grantId} className="py-2">
                  <p className="font-medium">{title}</p>
                  {meta.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {meta.join(" · ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {isEmpty ? (
        <p className="mt-6 text-muted-foreground">
          This person held no assets and had no active access. This act stands as a
          record of their departure.
        </p>
      ) : null}

      {/* Handover note */}
      <section className="mt-7">
        <h2 className="text-label uppercase text-muted-foreground">Note</h2>
        <p className="mt-2 whitespace-pre-wrap">{note}</p>
      </section>

      {/* Signatures */}
      <section className="mt-12 grid grid-cols-2 gap-10">
        {["Employee", "IT"].map((who) => (
          <div key={who}>
            <div className="h-10 border-b border-foreground/40" />
            <div className="mt-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>{who} signature</span>
              <span>Date</span>
            </div>
          </div>
        ))}
      </section>

      {/* Status caption */}
      <footer className="mt-10 border-t border-foreground/20 pt-3 text-xs text-muted-foreground">
        Pending — to be completed at handover.
      </footer>
    </main>
  );
}
