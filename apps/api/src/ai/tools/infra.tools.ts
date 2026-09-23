import { AgentDistController } from '../../agent-dist/agent-dist.controller';
import { InfraController } from '../../infra/infra.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING =
  'Pending: the infra toolset (W2-10, read only in v1) binds or excludes it.';

/**
 * The INFRA toolset (W2-10): the topology graph, read only in v1. Pre-created by the AI core unit; its unit
 * fills `tools` and replaces the pending entries with a decision per handler. The coverage test fails on
 * any handler left undecided.
 */
export const infraToolset: AiToolset = {
  domain: 'infra',
  tools: [],
  unexposed: [
    unexposed(
      InfraController,
      [
        'getAgentFleet',
        'getAgentPolicy',
        'listNodePage',
        'listGraphNodes',
        'listGraphEdges',
        'getNode',
        'listNodeChanges',
        'getImpact',
        'listAutoConfirmRules',
        'identityMatches',
        'listEdges',
        'createNode',
        'patchPosition',
        'updateNode',
        'removeNode',
        'restoreNode',
        'confirmNode',
        'bulkConfirm',
        'bulkDiscard',
        'createAutoConfirmRule',
        'updateAutoConfirmRule',
        'removeAutoConfirmRule',
        'mergeNodeInto',
        'createEdge',
        'closeEdge',
      ],
      PENDING,
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
