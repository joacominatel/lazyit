import { AdminGate } from "../_components/admin-gate";
import { SmtpSettingsEditor } from "./_components/smtp-settings-editor";

/**
 * Settings → Email (#1533) — the outbound-email (SMTP) editor and its test send, split out of the
 * former all-in-one Settings → Instance page so each integration has its own route.
 *
 * NOT an ADR-0067 server-prefetch route, deliberately: `getSmtpSettings` takes no access token (it
 * resolves one from the client session store), so a Server Component prefetch would fire
 * unauthenticated and be swallowed — a wasted round-trip, not a faster first paint. Same reasoning as
 * Settings → Reporting agents. The client `AdminGate` (`settings:manage`) wraps the editor; the API's
 * guard is the real boundary.
 */
export default function EmailSettingsPage() {
  return (
    <AdminGate>
      <SmtpSettingsEditor />
    </AdminGate>
  );
}
