import { AdminGate } from "../_components/admin-gate";
import { DirectorySettingsEditor } from "./_components/directory-settings-editor";

/**
 * Settings → Directory (#1533) — the AD/LDAP directory-source editor, Sync now and the review tray,
 * split out of the former all-in-one Settings → Instance page.
 *
 * NOT an ADR-0067 server-prefetch route, deliberately: `getDirectoryConnection` takes no access token
 * (it resolves one from the client session store), so a Server Component prefetch would fire
 * unauthenticated and be swallowed. Same reasoning as Settings → Reporting agents. The client
 * `AdminGate` (`settings:manage`) wraps the editor; the API's guard is the real boundary.
 */
export default function DirectorySettingsPage() {
  return (
    <AdminGate>
      <DirectorySettingsEditor />
    </AdminGate>
  );
}
