import { Skeleton } from "@/components/ui/skeleton";

/**
 * Group-level loading fallback for the authenticated app tree (ADR-0067 §4). Next renders this in
 * the `(app)` layout's `<main>` slot (the sidebar/topbar stay mounted) while a route segment's
 * Server Component suspends — e.g. the pilot pages while their `prefetchQuery` resolves. It is a
 * generic title + list shape (the shared shape across the piloted list pages), so any segment that
 * doesn't ship its own `loading.tsx` still gets a calm skeleton instead of a blank `<main>`. The
 * `animate-shimmer` sweep is composed over each Skeleton's muted fill (the primitive stays
 * untouched); reduced-motion stills the sweep globally.
 *
 * Individual segments may override this with their own `loading.tsx` for a shape-matched skeleton;
 * the loaded views still render their in-component skeletons for client-side refetch/filter states.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6">
      {/* Page header: title + subtitle */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-48 animate-shimmer" />
        <Skeleton className="h-4 w-72 animate-shimmer" />
      </div>
      {/* Toolbar: search + filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <Skeleton className="h-9 w-full animate-shimmer lg:max-w-xs" />
        <Skeleton className="h-9 w-full animate-shimmer lg:w-44" />
        <Skeleton className="h-9 w-full animate-shimmer lg:w-44" />
      </div>
      {/* List rows */}
      <div className="space-y-2">
        {["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => (
          <Skeleton key={key} className="h-12 w-full animate-shimmer rounded-lg" />
        ))}
      </div>
    </div>
  );
}
