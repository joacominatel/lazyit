import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RegisteredAiTool } from './tool-descriptor';

/**
 * The per-Service-Account mutation cap counts CHANGES, not calls (SEC-081): a batch that writes 200
 * assets is 200 changes. A tool declares its weight with `mutationWeight(input)` (default 1); the cap
 * compares what the run (headless) or the rolling hour (MCP) already used plus the next call's weight.
 */

/** The changes one call counts for: the tool's `mutationWeight` over the validated input, at least 1. */
export function mutationWeightOf(
  tool: RegisteredAiTool | undefined,
  rawInput: unknown,
): number {
  if (!tool || typeof tool.descriptor.mutationWeight !== 'function') return 1;
  const { descriptor } = tool;
  const parsed = descriptor.input.safeParse(
    descriptor.normalizeInput ? descriptor.normalizeInput(rawInput) : rawInput,
  );
  // An input the tool refuses is refused by core before anything runs; it counts as one call here.
  if (!parsed.success) return 1;
  const weight = Math.floor(descriptor.mutationWeight?.(parsed.data) ?? 1);
  return Number.isFinite(weight) && weight > 1 ? weight : 1;
}

/**
 * The changes the write invocations matching `where` account for. Unweighted tools are counted in the
 * database; the rows of weighted tools (the batches) are read to weigh their stored input — at most
 * `cap` of them, since each counts at least 1 and `cap` rows already reach the cap.
 */
export async function mutationsUsed(
  prisma: Pick<PrismaService, 'aiToolInvocation'>,
  tools: readonly RegisteredAiTool[],
  where: Prisma.AiToolInvocationWhereInput,
  cap: number,
): Promise<number> {
  const total = await prisma.aiToolInvocation.count({ where });
  const weighted = tools.filter(
    (tool) => typeof tool.descriptor.mutationWeight === 'function',
  );
  if (total === 0 || weighted.length === 0) return total;
  const byName = new Map(weighted.map((tool) => [tool.descriptor.name, tool]));
  // `where` never filters on the tool name itself (the callers filter on class, run, SA and window).
  const batchWhere: Prisma.AiToolInvocationWhereInput = {
    ...where,
    toolName: { in: [...byName.keys()] },
  };
  const batchCount = await prisma.aiToolInvocation.count({
    where: batchWhere,
  });
  if (batchCount === 0) return total;
  const rows = await prisma.aiToolInvocation.findMany({
    where: batchWhere,
    select: { toolName: true, input: true },
    take: Math.max(1, cap),
  });
  const weights = rows.reduce(
    (sum, row) => sum + mutationWeightOf(byName.get(row.toolName), row.input),
    0,
  );
  // Rows past `take` count 1 each: the sum is already at or over the cap.
  return total - batchCount + weights + (batchCount - rows.length);
}
