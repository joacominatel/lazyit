import { z } from 'zod';
import {
  InfraNodeKindSchema,
  InfraNodeListRoleSchema,
  InfraNodeSourceSchema,
  InfraNodeStateSchema,
  InfraNodeStatusSchema,
} from '@lazyit/shared';
import { AgentDistController } from '../../agent-dist/agent-dist.controller';
import { InfraController } from '../../infra/infra.controller';
import { INFRA_NODE_SORT_ALLOWLIST } from '../../infra/infra.service';
import {
  AI_TOOL_LIST_DEFAULT_LIMIT,
  AI_TOOL_LIST_MAX_LIMIT,
} from '../ai.constants';
import { untrusted } from '../core/result-shaper';
import {
  bind,
  defineTool,
  unexposed,
  type AiToolset,
} from '../core/tool-descriptor';

/**
 * The INFRA toolset (W2-10; tools-and-execution.md §7 rows 43–44): the topology graph, READ ONLY in v1.
 * Every read goes through `rt.call` — the route's own guards, pipes and controller logic, as the
 * principal — and is projected to a concise, named shape.
 *
 * What never leaves this file: the node's secret HANDLES (`secretRefs`, Secret Manager adjacency —
 * ADR-0061), the raw `specs` blob (the whole reported inventory), the agent-reporting keys
 * (`reportingSource` / `externalId`) and anything about agent credentials. Text an agent reported (an
 * agent node's label and inventory name, the reported host facts) is wrapped as untrusted content, and
 * so is the label of any lean row whose provenance the route does not say.
 */

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null ? (value as Row) : {};
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

/** Keep only the named fields of a row (a concise projection; unknown rows become `{}`). */
function pick(row: unknown, fields: readonly string[]): Row {
  const source = asRow(row);
  const out: Row = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A node's label. Only a hand-drawn (`MANUAL`) node's label is operator-curated; an agent-reported one is
 * the hostname the host chose for itself, and a lean row (child, impact, peer) does not say which — both
 * are wrapped as untrusted (INV-AI-4).
 */
function nodeLabel(row: Row): string | null {
  const label = str(row.label);
  return row.source === 'MANUAL' ? label : untrusted(label);
}

/** The lean `{ id, label, kind, status }` shape children, impact rows and edge peers share. */
function leanNode(row: Row): Row {
  return { ...pick(row, ['id', 'kind', 'status']), label: nodeLabel(row) };
}

function owners(value: unknown): Row[] {
  return asRows(value).map((o) =>
    pick(o, ['userId', 'firstName', 'lastName', 'email', 'deletedAt']),
  );
}

/** The node summary both tools share. */
function nodeSummary(row: Row): Row {
  const out = pick(row, [
    'id',
    'kind',
    'status',
    'state',
    'source',
    'ipAddress',
    'chassis',
    'assetId',
    'lastReportedAt',
    'agentVersion',
  ]);
  out.label = nodeLabel(row);
  if ('assetName' in row) {
    // An auto-created Asset of an agent node takes its name from the reported hostname.
    out.assetName =
      row.source === 'MANUAL'
        ? str(row.assetName)
        : untrusted(str(row.assetName));
  }
  return out;
}

/**
 * A few reported host facts from the drill-in's `specs` (never the software list, identifiers or NICs),
 * serialized and wrapped as untrusted: every value is what the host said about itself.
 */
function reportedHost(specs: unknown): string | null {
  const host = asRow(asRow(specs).host);
  if (Object.keys(host).length === 0) return null;
  const os = asRow(host.os);
  const cpu = asRow(host.cpu);
  const hardware = asRow(host.hardware);
  const facts: Row = {
    hostname: host.hostname,
    fqdn: host.fqdn,
    os: pick(os, ['family', 'name', 'version', 'kernel', 'build']),
    virtualization: asRow(host.virtualization).type,
    cpu: pick(cpu, ['model', 'cores']),
    memoryBytes: host.memoryBytes,
    hardware: pick(hardware, ['manufacturer', 'model']),
    bootedAt: host.bootedAt,
  };
  return untrusted(JSON.stringify(facts));
}

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(AI_TOOL_LIST_MAX_LIMIT)
  .optional()
  .describe(
    `Page size (default ${AI_TOOL_LIST_DEFAULT_LIMIT}, max ${AI_TOOL_LIST_MAX_LIMIT}).`,
  );

const SORT_FIELDS = Object.keys(INFRA_NODE_SORT_ALLOWLIST) as [
  keyof typeof INFRA_NODE_SORT_ALLOWLIST,
  ...(keyof typeof INFRA_NODE_SORT_ALLOWLIST)[],
];

const infraNodeSearch = defineTool({
  name: 'infra_node_search',
  title: 'Search infrastructure nodes',
  description:
    'Search the infrastructure topology (servers, VMs, containers, network devices, storage…). ' +
    'Filter by kind, status (ONLINE/OFFLINE/UNKNOWN), state (CONFIRMED on the map, PENDING in the review ' +
    'tray), source (MANUAL or AGENT-reported), role (HOST or CHILD) or the Assets that back them; `query` ' +
    "matches the label, IP address, the linked Asset's name and its owners. Returns a page of nodes with " +
    'their ids and the total. Use it to find a node before calling infra_node_get; never guess an id.',
  domain: 'infra',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive text to look for.'),
    kind: z.enum(InfraNodeKindSchema.options).optional(),
    status: z.enum(InfraNodeStatusSchema.options).optional(),
    state: z.enum(InfraNodeStateSchema.options).optional(),
    source: z.enum(InfraNodeSourceSchema.options).optional(),
    role: z
      .enum(InfraNodeListRoleSchema.options)
      .optional()
      .describe(
        'HOST excludes container/guest children; CHILD keeps only them.',
      ),
    assetIds: z
      .array(z.cuid())
      .min(1)
      .max(AI_TOOL_LIST_MAX_LIMIT)
      .optional()
      .describe('Only the nodes backing these Asset ids.'),
    sort: z.enum(SORT_FIELDS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    limit: pageSize,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Rows to skip (default 0).'),
  }),
  bindings: [bind(InfraController, 'listNodePage')],
  async run(input, rt) {
    const limit = input.limit ?? AI_TOOL_LIST_DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = await rt.call(InfraController, 'listNodePage', {
      query: {
        q: input.query,
        kind: input.kind,
        status: input.status,
        state: input.state,
        source: input.source,
        role: input.role,
        assetIds: input.assetIds?.join(','),
        sort: input.sort,
        dir: input.dir,
        limit: String(limit),
        offset: String(offset),
      },
    });
    const items = asRows(page.items).map((row) => ({
      ...nodeSummary(row),
      owners: owners(row.owners),
    }));
    const total = typeof page.total === 'number' ? page.total : items.length;
    const nextOffset = offset + items.length;
    return {
      data: { total, offset, items },
      ...(nextOffset < total
        ? { truncated: { shown: items.length, total, nextOffset } }
        : {}),
    };
  },
});

const infraNodeGet = defineTool({
  name: 'infra_node_get',
  title: 'Get an infrastructure node',
  description:
    'One infrastructure node by id: what it is, its linked Asset and owners, the nodes it hosts ' +
    '(children), its edges to other nodes and its blast radius — how many nodes go down with it ' +
    '(transitively, over RUNS_ON and DEPENDS_ON). An edge is `outgoing` when this node is its source ' +
    '("this RUNS_ON peer") and `incoming` when it is the target. detail "full" adds the affected nodes ' +
    'with their hop depth, linked KB articles, nodes sharing its IP address and the facts its agent ' +
    'reported about the host. Find the id with infra_node_search first.',
  domain: 'infra',
  class: 'read',
  idempotent: true,
  input: z.strictObject({
    id: z.cuid().describe('The node id (from infra_node_search).'),
    detail: z
      .enum(['concise', 'full'])
      .default('concise')
      .describe('"full" adds the blast-radius list, articles and host facts.'),
    includeClosedEdges: z
      .boolean()
      .default(false)
      .describe('Also list ended edges (migration history).'),
  }),
  bindings: [
    bind(InfraController, 'getNode'),
    bind(InfraController, 'listEdges'),
    bind(InfraController, 'getImpact'),
    bind(InfraController, 'listNodePage'),
  ],
  async run(input, rt) {
    const params = { id: input.id };
    const node = asRow(await rt.call(InfraController, 'getNode', { params }));
    const edges = asRows(
      await rt.call(InfraController, 'listEdges', {
        params,
        query: { active: String(!input.includeClosedEdges) },
      }),
    );
    const impact = asRow(
      await rt.call(InfraController, 'getImpact', { params }),
    );

    const shownEdges = edges.slice(0, AI_TOOL_LIST_MAX_LIMIT);
    const peerIds = [
      ...new Set(
        shownEdges.map((e) =>
          e.sourceId === input.id ? str(e.targetId) : str(e.sourceId),
        ),
      ),
    ].filter((id): id is string => id !== null);
    const peers = new Map<string, Row>();
    if (peerIds.length > 0) {
      const page = await rt.call(InfraController, 'listNodePage', {
        query: { ids: peerIds.join(','), limit: String(peerIds.length) },
      });
      for (const row of asRows(page.items)) {
        if (typeof row.id === 'string') peers.set(row.id, leanNode(row));
      }
    }

    const children = asRows(node.children);
    const affected = asRows(impact.affected);
    const data: Row = {
      node: { ...nodeSummary(node), owners: owners(node.owners) },
      children: {
        total: children.length,
        items: children.slice(0, AI_TOOL_LIST_MAX_LIMIT).map(leanNode),
      },
      edges: {
        total: edges.length,
        items: shownEdges.map((e) => {
          const outgoing = e.sourceId === input.id;
          const peerId = str(outgoing ? e.targetId : e.sourceId);
          return {
            ...pick(e, ['id', 'kind', 'startedAt', 'endedAt']),
            direction: outgoing ? 'outgoing' : 'incoming',
            // A peer the list no longer returns (discarded meanwhile) keeps its id only.
            peer: (peerId && peers.get(peerId)) ?? { id: peerId },
          };
        }),
      },
      impact: { affectedTotal: affected.length },
    };

    if (input.detail === 'full') {
      (data.impact as Row).affected = affected
        .slice(0, AI_TOOL_LIST_MAX_LIMIT)
        .map((a) => ({ ...leanNode(a), depth: a.depth }));
      data.articles = asRows(node.articleLinks).map((a) =>
        pick(a, ['id', 'slug', 'title']),
      );
      data.ipConflicts = asRows(node.ipConflict).map(leanNode);
      data.reportedHost = reportedHost(node.specs);
    }
    return { data };
  },
});

const V1_1_WRITES =
  'Deferred to v1.1: infra node and edge writes (tools-and-execution.md §3, §7).';

export const infraToolset: AiToolset = {
  domain: 'infra',
  tools: [infraNodeSearch, infraNodeGet],
  unexposed: [
    unexposed(
      InfraController,
      [
        'createNode',
        'patchPosition',
        'updateNode',
        'removeNode',
        'restoreNode',
        'bulkDiscard',
        'createEdge',
        'closeEdge',
      ],
      V1_1_WRITES,
    ),
    unexposed(
      InfraController,
      [
        'confirmNode',
        'bulkConfirm',
        'mergeNodeInto',
        'createAutoConfirmRule',
        'updateAutoConfirmRule',
        'removeAutoConfirmRule',
      ],
      'Deferred to v1.1: review-tray curation (confirm, merge, auto-confirm rules) is human-only (tools-and-execution.md §3).',
    ),
    unexposed(
      InfraController,
      ['listAutoConfirmRules', 'identityMatches', 'listNodeChanges'],
      'Deferred to v1.1 with the curation surface they serve; not in the 44-tool v1 cut (tools-and-execution.md §7).',
    ),
    unexposed(
      InfraController,
      ['listGraphNodes', 'listGraphEdges'],
      "The canvas's unpaged bulk reads (up to 10,000 rows); infra_node_search and infra_node_get are the paged equivalents.",
    ),
    unexposed(
      InfraController,
      ['getAgentFleet'],
      'Not in the v1 cut: the fleet view carries the agent credential inventory for settings:manage callers, which no tool surfaces.',
    ),
    unexposed(
      InfraController,
      ['getAgentPolicy'],
      'Deferred with the agent-policy writes: elevated instance configuration, later (tools-and-execution.md §3).',
    ),
    unexposed(
      InfraController,
      [
        'putAgentPolicy',
        'putServiceAccountAgentPolicy',
        'deleteServiceAccountAgentPolicy',
        'putNodeAgentPolicy',
        'deleteNodeAgentPolicy',
      ],
      'Deferred: agent policy is elevated instance configuration, later (tools-and-execution.md §3).',
    ),
    unexposed(
      InfraController,
      ['listNodes'],
      'An @Res passthrough; the paged listNodePage is the readable equivalent.',
    ),
    unexposed(
      InfraController,
      ['report'],
      "Not applicable: the reporting agent's ingestion endpoint (infra:report).",
    ),
    unexposed(
      InfraController,
      ['attachSecret', 'detachSecret'],
      'Excluded: Secret Manager adjacency (ADR-0061).',
    ),
    unexposed(
      AgentDistController,
      ['download', 'checksum'],
      'Not applicable: the reporting agent binary distribution.',
    ),
  ],
};
