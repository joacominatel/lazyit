"use client";

import type { LocationDetail } from "@lazyit/shared";
import Link from "next/link";
import { useLocation } from "@/lib/api/hooks/use-locations";

/**
 * An asset's location shown as its FULL ancestry path (site → room → rack) instead of just the leaf
 * name (#845). Reuses `useLocation` to pull the detail's `path` (root→self inclusive); each ancestor
 * links to its own detail, the leaf is the location itself. Progressive: the leaf renders immediately
 * from the embedded `{ id, name }`, ancestors fill in once the detail resolves — so a missing/legacy
 * `path` degrades to exactly the previous single-link behavior.
 */
export function AssetLocationPath({ id, name }: { id: string; name: string }) {
  const { data } = useLocation(id);
  const path = (data as LocationDetail | undefined)?.path;
  const ancestors = path && path.length > 1 ? path.slice(0, -1) : [];
  const fullPath =
    path && path.length > 0 ? path.map((hop) => hop.name).join(" / ") : name;

  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-0.5"
      title={fullPath}
    >
      {ancestors.map((hop) => (
        <span key={hop.id} className="inline-flex items-center">
          <Link
            href={`/locations/${hop.id}`}
            className="text-muted-foreground hover:underline"
          >
            {hop.name}
          </Link>
          <span aria-hidden className="px-1 text-muted-foreground/50">
            /
          </span>
        </span>
      ))}
      <Link href={`/locations/${id}`} className="font-medium hover:underline">
        {name}
      </Link>
    </span>
  );
}
