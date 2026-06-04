import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SessionTokenSync } from "@/components/session-token-sync";

/**
 * Print route group — a chrome-less shell for printable documents (Wave 3b: the offboarding Return
 * Act). It deliberately drops the sidebar / topbar / breadcrumb of the `(app)` shell so the page is
 * the document and nothing else, but it KEEPS the same auth guard: a printable act can expose a
 * person's held assets and access, so it is private. The guard is belt-and-suspenders alongside
 * `middleware.ts` (ADR-0039), exactly as in the `(app)` layout.
 *
 * `SessionTokenSync` is rendered here so the client-side TanStack queries on the print page can
 * attach the Auth.js access token as a Bearer header — the same plumbing the `(app)` group relies on.
 * Theme/query/session providers come from the root layout, so they are not re-declared here.
 */
export default async function PrintLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-svh bg-white text-foreground">
      <SessionTokenSync />
      {children}
    </div>
  );
}
