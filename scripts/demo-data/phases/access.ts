import type {
  AccessGrant,
  AccessRequest,
  AdminPasswordResetOutcome,
  ChangePasswordResponse,
  CreateAccessGrant,
  CreateAccessRequest,
} from "@lazyit/shared";
import { Client, login, pool } from "../lib/api";
import { type Ctx, sortedEntries } from "../lib/context";
import { rngFor } from "../lib/rng";
import { APPLICATIONS, DENY_REASONS, GRANT_NOTES, JUSTIFICATIONS, REVOKE_NOTES } from "../lib/words";
import { randomPassword, type UserPlan } from "./users";

const POPULARITY: Record<string, number> = {
  "Google Workspace": 30, Slack: 28, Okta: 25, "CrowdStrike Falcon": 15, Workday: 12, Zoom: 10, "Corporate VPN": 10,
  "Jira Software": 8, Confluence: 8, "GitHub Enterprise": 5, "1Password Business": 4, Salesforce: 3, Datadog: 2,
  "AWS Production": 2, Figma: 2, "Internal Billing Portal": 2, NetSuite: 1,
};
const LEVEL_WEIGHTS = [75, 20, 5, 3];

const DAY_MS = 86_400_000;
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString();
const levelsOf = (app: string) => APPLICATIONS.find((a) => a.name === app)?.levels ?? ["User"];

interface GrantPlan {
  key: string;
  userIndex: number;
  app: string;
  body: Omit<CreateAccessGrant, "userId" | "applicationId">;
  revoke: boolean;
}

function planGrants(ctx: Ctx): GrantPlan[] {
  const apps = sortedEntries(ctx.applications).map(([name]) => [name, POPULARITY[name] ?? 1] as const);
  const userCount = ctx.users.length;
  const used = new Set<string>();
  const plans: GrantPlan[] = [];
  if (apps.length === 0 || userCount === 0) return plans;
  for (let g = 0; g < ctx.volumes.grants; g++) {
    const rng = rngFor(ctx.seed, "grant", g);
    let userIndex = 0;
    let app = "";
    let attempt = 0;
    do {
      userIndex = rng.int(0, userCount - 1);
      app = rng.weighted(apps);
      attempt++;
    } while (used.has(`${userIndex}|${app}`) && attempt < 8);
    if (used.has(`${userIndex}|${app}`)) continue;
    used.add(`${userIndex}|${app}`);
    const levels = levelsOf(app);
    const accessLevel = rng.weighted(levels.map((l, i) => [l, LEVEL_WEIGHTS[i] ?? 2] as const));
    const roll = rng.next();
    let grantedDays = rng.int(1, 900);
    let expiresAt: string | undefined;
    if (roll < 0.1) {
      expiresAt = new Date(Date.now() + rng.int(30, 365) * DAY_MS).toISOString();
    } else if (roll < 0.135) {
      grantedDays = rng.int(200, 900);
      expiresAt = isoDaysAgo(grantedDays - rng.int(30, 180));
    } else if (roll < 0.155) {
      expiresAt = new Date(Date.now() + rng.int(3, 13) * DAY_MS).toISOString();
    }
    plans.push({
      key: `${userIndex}|${app}|${accessLevel}`,
      userIndex,
      app,
      body: {
        accessLevel,
        grantedAt: isoDaysAgo(grantedDays),
        ...(expiresAt ? { expiresAt } : {}),
        ...(rng.chance(0.2) ? { notes: rng.pick(GRANT_NOTES) } : {}),
      },
      revoke: !expiresAt && rng.chance(0.08),
    });
  }
  return plans;
}

export async function runGrants(ctx: Ctx): Promise<void> {
  const { api, report } = ctx;
  const plans = planGrants(ctx);
  // The per-application list is unpaginated; the top-level one pages over a non-unique grantedAt.
  const keys = new Set<string>();
  for (const applicationId of ctx.applications.values()) {
    const grants = await api.get<AccessGrant[]>(`/applications/${applicationId}/access-grants`, { activeOnly: false, includeExpired: true });
    for (const g of grants) keys.add(`${g.userId}|${g.applicationId}|${g.accessLevel ?? ""}`);
  }
  const progress = report.progress("grants", plans.length);
  await pool(plans, ctx.concurrency, async (plan) => {
    progress.tick();
    const userId = ctx.users[plan.userIndex]?.id;
    const applicationId = ctx.applications.get(plan.app);
    if (!userId || !applicationId) return;
    if (keys.has(`${userId}|${applicationId}|${plan.body.accessLevel ?? ""}`)) {
      report.skipped("access grant");
      return;
    }
    let grant: AccessGrant;
    try {
      grant = await api.post<AccessGrant>("/access-grants", { ...plan.body, userId, applicationId });
      report.created("access grant");
    } catch (err) {
      report.failed("access grant", plan.key, err);
      return;
    }
    if (!plan.revoke) return;
    try {
      await api.patch(`/access-grants/${grant.id}/revoke`, { notes: REVOKE_NOTES[plan.userIndex % REVOKE_NOTES.length] });
      report.created("access grant revoke");
    } catch (err) {
      report.failed("access grant revoke", plan.key, err);
    }
  });
}

type Outcome = "PENDING" | "APPROVED" | "DENIED";

interface RequestPlan {
  app: string;
  body: Omit<CreateAccessRequest, "applicationId">;
  outcome: Outcome;
  denyReason: string;
}

function planRequests(ctx: Ctx, requester: UserPlan, ordinal: number): RequestPlan[] {
  const rng = rngFor(ctx.seed, "requests", requester.index);
  const apps = rng.sample(sortedEntries(ctx.applications).map(([name]) => name), rng.int(3, 6));
  return apps.map((app, i) => {
    const forced: Outcome[] = ["PENDING", "APPROVED", "DENIED"];
    const outcome: Outcome =
      ordinal === 0 && i < 3
        ? forced[i]!
        : rng.weighted([["PENDING", 40], ["APPROVED", 35], ["DENIED", 25]] as const);
    const levels = levelsOf(app);
    return {
      app,
      body: {
        accessLevel: rng.weighted(levels.map((l, k) => [l, LEVEL_WEIGHTS[k] ?? 2] as const)),
        ...(rng.chance(0.85) ? { justification: rng.pick(JUSTIFICATIONS) } : {}),
      },
      outcome,
      denyReason: rng.pick(DENY_REASONS),
    };
  });
}

// Requests are self-service only, so each requester signs in via an admin temp-password reset and swaps it for a password nobody keeps.
async function signInAs(ctx: Ctx, userId: string, email: string): Promise<Client> {
  const reset = await ctx.api.post<AdminPasswordResetOutcome>(`/users/${userId}/reset-password`, {
    delivery: "temporary-password",
  });
  if (reset.delivery !== "temporary-password") throw new Error("reset did not return a temporary password");
  const session = await login(new Client(ctx.api.base), email, reset.temporaryPassword);
  const asTemp = ctx.api.withToken(session.token);
  const changed = await asTemp.post<ChangePasswordResponse>("/auth/change-password", {
    currentPassword: reset.temporaryPassword,
    newPassword: randomPassword(),
  });
  return ctx.api.withToken(changed.token);
}

export async function runRequests(ctx: Ctx, users: UserPlan[]): Promise<void> {
  const { api, report } = ctx;
  const requesters = users.filter((u) => u.requester);
  const progress = report.progress("requesters", requesters.length);
  for (const [ordinal, requester] of requesters.entries()) {
    progress.tick();
    const userId = ctx.users[requester.index]?.id;
    if (!userId) continue;
    const plans = planRequests(ctx, requester, ordinal);
    if ((await api.total("/access-requests", { requesterId: userId })) > 0) {
      report.skipped("access request", plans.length);
      continue;
    }
    let asUser: Client;
    try {
      asUser = await signInAs(ctx, userId, requester.email);
    } catch (err) {
      report.failed("access request", `${requester.email} sign-in`, err);
      continue;
    }
    for (const plan of plans) {
      const applicationId = ctx.applications.get(plan.app);
      if (!applicationId) continue;
      let request: AccessRequest;
      try {
        request = await asUser.post<AccessRequest>("/access-requests", { ...plan.body, applicationId });
        report.created("access request");
      } catch (err) {
        report.failed("access request", `${requester.email} -> ${plan.app}`, err);
        continue;
      }
      try {
        if (plan.outcome === "APPROVED") {
          await api.post(`/access-requests/${request.id}/approve`);
          report.created("access request decision");
        } else if (plan.outcome === "DENIED") {
          await api.post(`/access-requests/${request.id}/deny`, { reason: plan.denyReason });
          report.created("access request decision");
        }
      } catch (err) {
        report.failed("access request decision", `${requester.email} -> ${plan.app}`, err);
      }
    }
    try {
      await asUser.post("/auth/logout");
    } catch {
      // The session ends with its 12h expiry anyway.
    }
  }
}

export const GRANT_ENTITIES = ["access grant", "access grant revoke"];
export const REQUEST_ENTITIES = ["access request", "access request decision"];
