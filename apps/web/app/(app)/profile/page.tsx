import { AccountSubNav } from "@/app/(app)/account/_components/account-sub-nav";
import { ProfileView } from "./_components/profile-view";

/**
 * `/profile` — the self-service "My profile" page (issue #947). A thin Server Component that renders
 * the client {@link ProfileView}. Nothing is server-prefetched: the caller's `me` read is already
 * warmed app-wide (the topbar menu + permission gate read it), and the two `mine` reads are self-scope
 * and client-fetched. Any authenticated user may reach this route — the data endpoints are the ones
 * that enforce the self-scope (a VIEWER reads only their OWN assets/grants).
 *
 * `/profile` keeps its URL but belongs to the account area (#1404): it shares the account
 * sub-navigation with `/account/*`, at the profile's own width.
 */
export default function ProfilePage() {
  return (
    <div className="space-y-6">
      <AccountSubNav className="mx-auto max-w-4xl" />
      <ProfileView />
    </div>
  );
}
