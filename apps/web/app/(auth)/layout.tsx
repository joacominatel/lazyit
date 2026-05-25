// Public auth shell: a single centered column, no navigation or chrome.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      {children}
    </div>
  );
}
