import { ForcedChangePassword } from "./forced-change-password";

/**
 * `/change-password` — the blocking forced-change wall (ADR-0086 §F4b). A thin Server Component; the
 * client {@link ForcedChangePassword} mounts the session-token sync + the change-password form and, on
 * success, releases the user back into the app. The layout guards auth + local-mode.
 */
export default function ChangePasswordPage() {
  return <ForcedChangePassword />;
}
