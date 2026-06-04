/**
 * Composition-layer className recipes (ADR-0049 «Activated Restraint»).
 *
 * These are plain class strings applied at CALL SITES — never inside the vendored
 * `components/ui/*` primitives (which stay shadcn-clean). Keep every class a full,
 * non-interpolated string so the Tailwind v4 JIT scanner keeps it.
 */

/**
 * The coordinated hover "lift" — the signature "this is an interactive object" tell. On
 * hover a surface does THREE things at once: rises 2px, steps elevation e1 → e2, and
 * brightens its ring (foreground/10 → /15). Resting state grounds the surface at e1.
 *
 * The transition uses the motion tokens (`--dur-base` / `--ease-out-quad`). Reduced-motion
 * is handled globally: globals.css collapses transition durations to ~instant and the
 * consolidated `prefers-reduced-motion` block neutralizes the `hover:-translate-y-0.5`
 * transform, so reduced-motion users still get the elevation/ring change with no movement.
 *
 * Usage: `<Card className={lift}>` or `cn(lift, "...")`. Pairs with `<Link>`/role="button"
 * surfaces; do not apply to static table rows where vertical jitter hurts scanning.
 */
export const lift =
  "shadow-e1 ring-1 ring-foreground/10 transition-[transform,box-shadow,--tw-ring-color] duration-[var(--dur-base)] ease-[var(--ease-out-quad)] hover:-translate-y-0.5 hover:shadow-e2 hover:ring-foreground/15 motion-reduce:transition-none";
