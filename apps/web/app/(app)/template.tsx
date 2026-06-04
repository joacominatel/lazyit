// Per-navigation settle (ADR-0049 «Activated Restraint»). A template re-mounts on every
// route change inside the (app) group, so wrapping the page in `fade-in` gives a calm
// ~220ms cross-route settle with zero per-page wiring. It is OPACITY-ONLY (no transform) on
// purpose: a translate here would establish a containing block and re-anchor every
// `position: sticky` descendant to this wrapper for the duration of the animation, jolting
// sticky headers/toolbars after every navigation. The `rise-in` (translateY) settle stays
// for component-level surfaces (cards/lists) that have no sticky ancestor. The globals.css
// `prefers-reduced-motion` block collapses this to instant, so it is opt-out-safe.
export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="animate-fade-in">{children}</div>;
}
