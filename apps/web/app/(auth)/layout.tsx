import { AuthShell } from "@/components/auth-shell";

// Public auth shell: the shared AuthShell (wordmark + theme toggle + centered column), no app chrome.
// The first-run /setup wizard renders the same shell so login ↔ wizard never jumps.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthShell>{children}</AuthShell>;
}
