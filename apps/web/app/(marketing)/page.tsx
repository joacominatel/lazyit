export default function LandingPage() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        Coming soon
      </span>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        IT management for small teams, without the enterprise bloat.
      </h1>
      <p className="max-w-xl text-pretty text-muted-foreground">
        Asset inventory, application access, tickets, consumables and a knowledge
        base — self-hosted, opinionated and asset-centric.
      </p>
    </section>
  );
}
