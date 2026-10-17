import { redirect } from "next/navigation";

/**
 * `/settings/roles/permissions` — the old per-role permissions editor. Since #1540 both editable roles
 * are edited side by side in the matrix at `/settings/roles`, so old links, bookmarks and notification
 * deep links land there. The query string is forwarded unchanged (a stale `?role=` is harmless).
 */
export default async function RolePermissionsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value == null ? [] : [value]) {
      params.append(key, v);
    }
  }
  const query = params.toString();
  redirect(query ? `/settings/roles?${query}` : "/settings/roles");
}
