import { buildManualSearchIndex, getManualCategories } from "@/lib/manual/loader";
import { HelpSearch } from "./_components/help-search";
import { HelpSidebarMobile } from "./_components/help-sidebar-mobile";

/**
 * Help / Manual layout (ADR-0062 / issue #560). Wraps BOTH the `/help` index and every
 * `/help/<slug>` page in the documentation chrome: a persistent left sidebar (search + the
 * frontmatter-driven section→page nav) on desktop, a collapsible drawer on mobile, and the page
 * content beside it. Lives INSIDE the `(marketing)/help` segment, so it nests within the public
 * marketing shell (header/footer) rather than replacing it.
 *
 * Server Component: it loads the nested category index and the search index ONCE (server-side disk
 * reads via the loader) and passes them as plain props to the client sidebar/search. `force-dynamic`
 * mirrors the page components so a new/edited markdown page and a cookie-driven locale switch show
 * without a rebuild. Public, login-free (the `(marketing)` group + the `/help` allowance in `proxy.ts`).
 */
export const dynamic = "force-dynamic";

export default async function HelpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Load both indices once for the whole Help surface; the content tree is small (cheap per request).
  const [categories, searchIndex] = await Promise.all([
    getManualCategories(),
    buildManualSearchIndex(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 lg:flex-row lg:gap-10 lg:py-12">
      {/* Mobile: a hamburger that opens the sidebar in a drawer. Hidden on lg+. */}
      <HelpSidebarMobile index={searchIndex} categories={categories} />

      {/* Desktop: the persistent rail. Sticky so it tracks long pages; hidden below lg. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-20">
          <HelpSearch index={searchIndex} categories={categories} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
