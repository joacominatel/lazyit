import {
  DELETE_RESOLUTION_REQUIRED,
  type DeleteResolution,
} from "@lazyit/shared";
import { ApiError } from "./client";

// "Create a new one" is not an API mode: the web creates the target, then deletes with `move` (AUD-024 / AUD-085).
export type ResolutionChoice =
  | { kind: "detach" }
  | { kind: "move"; targetId: string }
  | { kind: "create"; name: string };

export function deleteResolutionQuery(resolution?: DeleteResolution): string {
  if (!resolution) return "";
  const qs = new URLSearchParams({ strategy: resolution.strategy });
  if (resolution.strategy === "move") qs.set("targetId", resolution.targetId);
  return `?${qs.toString()}`;
}

export function isDeleteResolutionRequired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const body = error.body as { code?: unknown } | undefined;
  return body?.code === DELETE_RESOLUTION_REQUIRED;
}

export function isChoiceReady(choice: ResolutionChoice | null): boolean {
  if (!choice) return false;
  if (choice.kind === "move") return choice.targetId !== "";
  if (choice.kind === "create") return choice.name.trim() !== "";
  return true;
}

// Carries the created target so a retry moves to it instead of creating a second one.
export class CreatedTargetDeleteError extends Error {
  constructor(
    readonly target: { id: string; name: string },
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Delete failed");
    this.name = "CreatedTargetDeleteError";
  }
}

export async function runDeleteResolution(
  choice: ResolutionChoice,
  ops: {
    remove: (resolution: DeleteResolution) => Promise<unknown>;
    create: (name: string) => Promise<{ id: string; name: string }>;
  },
): Promise<void> {
  if (choice.kind === "detach") {
    await ops.remove({ strategy: "detach" });
    return;
  }
  if (choice.kind === "move") {
    await ops.remove({ strategy: "move", targetId: choice.targetId });
    return;
  }
  const target = await ops.create(choice.name.trim());
  try {
    await ops.remove({ strategy: "move", targetId: target.id });
  } catch (error) {
    throw new CreatedTargetDeleteError({ id: target.id, name: target.name }, error);
  }
}

// The API refuses a move into the deleted location or anything below it.
export function locationSubtreeIds(
  locations: readonly { id: string; parentId: string | null }[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const location of locations) {
    if (location.parentId == null) continue;
    const siblings = children.get(location.parentId) ?? [];
    siblings.push(location.id);
    children.set(location.parentId, siblings);
  }
  const subtree = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      queue.push(child);
    }
  }
  return subtree;
}
