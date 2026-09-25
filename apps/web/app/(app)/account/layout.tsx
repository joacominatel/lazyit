import { AccountSubNav } from "./_components/account-sub-nav";

/**
 * The account area's shell (issue #1404): every `/account/*` page shares the account sub-navigation
 * above its own content. Each page keeps its own header, width and gating.
 */
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <AccountSubNav className="mx-auto max-w-3xl" />
      {children}
    </div>
  );
}
