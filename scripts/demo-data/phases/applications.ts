import type { Application, CreateApplication } from "@lazyit/shared";
import { pool } from "../lib/api";
import type { Ctx } from "../lib/context";
import { daysFromNow, rngFor } from "../lib/rng";
import { APPLICATION_CATEGORY_RENAMES, APPLICATIONS } from "../lib/words";
import { categoryId } from "./taxonomy";

export async function runApplications(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const [live, archived] = await Promise.all([
    api.all<Application>("/applications", { sort: "name" }),
    api.all<Application>("/applications", { deleted: "only", sort: "name" }),
  ]);
  const byName = new Map([...archived, ...live].map((a) => [a.name, a]));
  await pool(APPLICATIONS.slice(0, ctx.taxa.applications), ctx.concurrency, async (seed, i) => {
    const found = byName.get(seed.name);
    if (found) {
      if (!found.deletedAt) ctx.applications.set(seed.name, found.id);
      report.skipped("application");
      return;
    }
    const rng = rngFor(ctx.seed, "application", i);
    const category = categoryId(ctx.applicationCategories, seed.category, APPLICATION_CATEGORY_RENAMES);
    const body: CreateApplication = {
      name: seed.name,
      description: seed.description,
      url: seed.url,
      vendor: seed.vendor,
      isCritical: seed.critical,
      ...(category ? { categoryId: category } : {}),
      ...(seed.seats > 0 ? { seatsPurchased: seed.seats, costPerSeat: seed.costPerSeatCents } : {}),
      ...(rng.chance(0.8) ? { renewalDate: daysFromNow(rng.int(-20, 330)) } : {}),
      metadata: { owner: rng.pick(["IT Operations", "Security", "Engineering", "People Ops", "Finance"]), sso: rng.chance(0.8) },
      ...(seed.critical ? { notes: "Critical system: access changes need a second approver." } : {}),
    };
    try {
      const created = await api.post<Application>("/applications", body);
      ctx.applications.set(seed.name, created.id);
      report.created("application");
    } catch (err) {
      report.failed("application", seed.name, err);
    }
  });
}
