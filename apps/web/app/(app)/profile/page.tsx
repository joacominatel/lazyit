import { ProfileView } from "./_components/profile-view";

/**
 * `/profile` — the self-service "My profile" page (issue #947). A thin Server Component that renders
 * the client {@link ProfileView}. Nothing is server-prefetched: the caller's `me` read is already
 * warmed app-wide (the topbar menu + permission gate read it), and the two `mine` reads are self-scope
 * and client-fetched. Any authenticated user may reach this route — the data endpoints are the ones
 * that enforce the self-scope (a VIEWER reads only their OWN assets/grants).
 */
export default function ProfilePage() {
  return <ProfileView />;
}
