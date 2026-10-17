import type { CreateUser, Role, User, UserListItem } from "@lazyit/shared";
import { pool } from "../lib/api";
import type { Ctx } from "../lib/context";
import { rngFor, seedCode, slugify } from "../lib/rng";
import { EMAIL_DOMAIN, EXTERNAL_MANAGERS, FIRST_NAMES, LAST_NAMES } from "../lib/words";

export interface UserPlan {
  index: number;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  legajo?: string;
  username?: string;
  managerIndex?: number;
  externalManager?: string;
  deactivated: boolean;
  offboarded: boolean;
  tempPassword: boolean;
  requester: boolean;
}

const MANAGER_SPAN = 25;
const DIRECTOR_SPAN = 625;

const isOffboarded = (i: number) => i % 50 === 11;
const isDeactivated = (i: number) => i % 40 === 7;
const hasTempPassword = (i: number) => i % 500 === 17;
const isManager = (i: number) => i % MANAGER_SPAN === 0;

export function planUsers(seed: string, count: number, requesters: number): UserPlan[] {
  const taken = new Set<string>();
  const step = Math.max(1, Math.floor(count / Math.max(1, requesters)));
  const requesterSet = new Set<number>();
  for (let k = 0; k < requesters; k++) {
    let i = k * step + 5;
    while (i < count && (isOffboarded(i) || isDeactivated(i) || hasTempPassword(i) || requesterSet.has(i))) i++;
    if (i < count) requesterSet.add(i);
  }
  const code = seedCode(seed);
  const plans: UserPlan[] = [];
  for (let i = 0; i < count; i++) {
    const rng = rngFor(seed, "user", i);
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const base = `${slugify(firstName)}.${slugify(lastName)}`.replace(/-/g, "");
    let local = base;
    for (let n = 2; taken.has(local); n++) local = `${base}${n}`;
    taken.add(local);
    const role: Role = i % 250 === 3 ? "ADMIN" : i % 6 === 1 ? "MEMBER" : "VIEWER";
    let managerIndex: number | undefined;
    let externalManager: string | undefined;
    if (i % 33 === 4) externalManager = rng.pick(EXTERNAL_MANAGERS);
    else if (isManager(i)) managerIndex = i === 0 ? undefined : Math.floor(i / DIRECTOR_SPAN) * DIRECTOR_SPAN;
    else managerIndex = Math.floor(i / MANAGER_SPAN) * MANAGER_SPAN;
    if (managerIndex === i) managerIndex = i === 0 ? undefined : 0;
    plans.push({
      index: i,
      email: `${local}@${EMAIL_DOMAIN}`,
      firstName,
      lastName,
      role,
      legajo: i % 11 === 5 ? undefined : `${code}${10000 + i}`,
      username: i % 7 === 3 ? undefined : local,
      managerIndex,
      externalManager,
      deactivated: isDeactivated(i),
      offboarded: isOffboarded(i),
      tempPassword: hasTempPassword(i),
      requester: requesterSet.has(i),
    });
  }
  return plans;
}

export function randomPassword(): string {
  return `Dm-${crypto.randomUUID()}-aZ9!`;
}

export interface ExistingUser {
  id: string;
  isActive: boolean;
  deleted: boolean;
}

export async function loadUsers(ctx: Ctx): Promise<Map<string, ExistingUser>> {
  const [live, archived] = await Promise.all([
    ctx.api.all<UserListItem>("/users", { sort: "email" }),
    ctx.api.all<UserListItem>("/users", { deleted: "only", sort: "email" }),
  ]);
  const map = new Map<string, ExistingUser>();
  for (const u of live) map.set(u.email.toLowerCase(), { id: u.id, isActive: u.isActive, deleted: false });
  for (const u of archived) {
    if (!map.has(u.email.toLowerCase())) map.set(u.email.toLowerCase(), { id: u.id, isActive: u.isActive, deleted: true });
  }
  return map;
}

export async function runUsers(ctx: Ctx, plans: UserPlan[]): Promise<void> {
  const { api, report } = ctx;
  const existing = await loadUsers(ctx);
  // An offboarded user keeps no id here: nothing new may be assigned or granted to them.
  ctx.users = plans.map((p) => {
    const state = existing.get(p.email);
    return { index: p.index, email: p.email, id: state && !state.deleted ? state.id : undefined };
  });

  const create = async (plan: UserPlan) => {
    const slot = ctx.users[plan.index]!;
    if (slot.id || existing.has(plan.email)) {
      report.skipped("user");
      return;
    }
    const managerId = plan.managerIndex !== undefined ? ctx.users[plan.managerIndex]?.id : undefined;
    const body: CreateUser = {
      email: plan.email,
      firstName: plan.firstName,
      lastName: plan.lastName,
      role: plan.role,
      ...(plan.legajo ? { legajo: plan.legajo } : {}),
      ...(plan.username ? { username: plan.username } : {}),
      ...(managerId ? { manager: { managerId } } : plan.externalManager ? { manager: { managerName: plan.externalManager } } : {}),
      ...(plan.tempPassword ? { password: randomPassword() } : {}),
    };
    try {
      const user = await api.post<User>("/users", body);
      slot.id = user.id;
      existing.set(plan.email, { id: user.id, isActive: true, deleted: false });
      report.created("user");
    } catch (err) {
      report.failed("user", plan.email, err);
    }
  };

  const progress = report.progress("users", plans.length);
  const isDirector = (i: number) => i > 0 && i % DIRECTOR_SPAN === 0;
  // Top of the tree first, then directors, then managers, then everyone else, so every managerId exists.
  const waves = [
    plans.filter((p) => p.index === 0),
    plans.filter((p) => isDirector(p.index)),
    plans.filter((p) => isManager(p.index) && p.index > 0 && !isDirector(p.index)),
    plans.filter((p) => !isManager(p.index)),
  ];
  for (const wave of waves) {
    await pool(wave, ctx.concurrency, async (plan) => {
      await create(plan);
      progress.tick();
    });
  }

  await pool(plans.filter((p) => p.deactivated), ctx.concurrency, async (plan) => {
    const state = existing.get(plan.email);
    if (!state || state.deleted) return;
    if (!state.isActive) {
      report.skipped("user deactivation");
      return;
    }
    try {
      await api.patch(`/users/${state.id}`, { isActive: false });
      state.isActive = false;
      report.created("user deactivation");
    } catch (err) {
      report.failed("user deactivation", plan.email, err);
    }
  });
}

export async function runOffboarding(ctx: Ctx, plans: UserPlan[]): Promise<void> {
  const { api, report } = ctx;
  const existing = await loadUsers(ctx);
  await pool(plans.filter((p) => p.offboarded), ctx.concurrency, async (plan) => {
    const state = existing.get(plan.email);
    if (!state) return;
    if (state.deleted) {
      report.skipped("user offboarding");
      return;
    }
    try {
      await api.post(`/users/${state.id}/offboard`);
      report.created("user offboarding");
    } catch (err) {
      report.failed("user offboarding", plan.email, err);
    }
  });
}

export const USER_ENTITIES = ["user", "user deactivation"];
