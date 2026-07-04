import { NotificationPreferencesView } from "./_components/notification-preferences-view";

/**
 * `/account/notifications` — the self-service "Notification emails" page (issue #879). A thin Server
 * Component that renders the client {@link NotificationPreferencesView}. Any authenticated user reaches
 * it (self-scope; no permission gate) — the data endpoint resolves "me" server-side. Nothing is
 * server-prefetched: the single preferences read is self-scope and client-fetched.
 */
export default function AccountNotificationsPage() {
  return <NotificationPreferencesView />;
}
