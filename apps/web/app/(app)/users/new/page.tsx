import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { UserCreateForm } from "../_components/user-create-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (ADR-0067 rollout #662).
// User onboarding is admin-only (`user:manage`, the same gate as the "New user" button and the
// `POST /users` route). The {@link PermissionGate} is the route guard: a neutral skeleton while the
// permission set loads, an explicit "admin-only" locked state for anyone without `user:manage`, and
// the form for holders. The API enforces the same gate server-side, so this is a UI affordance, not
// the boundary (#936) — before this, a MEMBER reaching /users/new by URL saw the full onboarding form.
// No `breadcrumb` prop on the PageHeader below: the layout-level route-driven <Breadcrumb />
// (app/(app)/layout.tsx) already derives "Users › New" for this exact path from KNOWN_SEGMENTS —
// an explicit PageHeader breadcrumb rendered a visible duplicate above it (#972).
export default async function NewUserPage() {
  const t = await getTranslations("users");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PermissionGate
        permission="user:manage"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <PageHeader title={t("create.title")} subtitle={t("create.subtitle")} />
        <UserCreateForm />
      </PermissionGate>
    </div>
  );
}
