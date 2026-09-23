import { ConsumablesController } from '../../consumables/consumables.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

/**
 * The CONSUMABLES toolset (W2-7): consumables and their stock ledger. Pre-created by the AI core unit;
 * its unit fills `tools` and replaces the pending entries with a decision per handler. The coverage test
 * fails on any handler left undecided.
 */
export const consumablesToolset: AiToolset = {
  domain: 'consumables',
  tools: [],
  unexposed: [
    unexposed(
      ConsumablesController,
      [
        'findAll',
        'findOne',
        'findMovements',
        'create',
        'update',
        'remove',
        'restore',
        'createMovement',
      ],
      'Pending: the consumables toolset (W2-7) binds or excludes it.',
    ),
  ],
};
