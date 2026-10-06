import { AdminGate } from "../_components/admin-gate";
import { AssetTagSchemeEditor } from "./_components/asset-tag-scheme-editor";

/**
 * Settings → Asset tags (#1533) — the asset-tag scheme editor, its live preview and the backfill
 * wizard, split out of the former all-in-one Settings → Instance page.
 *
 * NOT an ADR-0067 server-prefetch route, deliberately: `getAssetTagScheme` takes no access token (it
 * resolves one from the client session store), so a Server Component prefetch would fire
 * unauthenticated and be swallowed. Same reasoning as Settings → Reporting agents. The client
 * `AdminGate` (`settings:manage`) wraps the editor; the API's guard is the real boundary.
 */
export default function AssetTagsSettingsPage() {
  return (
    <AdminGate>
      <AssetTagSchemeEditor />
    </AdminGate>
  );
}
