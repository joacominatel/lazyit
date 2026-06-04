// Per-navigation settle (ADR-0049 «Activated Restraint»). A template re-mounts on every
// route change inside the (app) group, so wrapping the page in `rise-in` gives a calm
// ~220ms cross-route settle (12px rise + fade) with zero per-page wiring. The globals.css
// `prefers-reduced-motion` block collapses this to instant, so it is opt-out-safe.
export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="animate-rise-in">{children}</div>;
}
