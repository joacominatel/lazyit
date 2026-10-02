import { unexposed, type AiToolset } from '../core/tool-descriptor';
import { PurchaseOrdersController } from '../../purchase-orders/purchase-orders.controller';
import { SuppliersController } from '../../purchase-orders/suppliers.controller';
import { SuggestionsController } from '../../suggestions/suggestions.controller';

const PHASE_3 = 'Purchases AI tools — Phase 3 (#1478)';

/**
 * Purchases (ADR-0099). No tool in Phase 1: purchase reads and writes reach the AI in Phase 3 (ADR-0099
 * §13), where purchase changes are never auto-approved (§11). Every handler is decided here so the
 * coverage test stays green; Phase 3 moves them into tools.
 */
export const purchasesToolset: AiToolset = {
  domain: 'purchases',
  tools: [],
  unexposed: [
    unexposed(
      PurchaseOrdersController,
      [
        'findAll',
        'findOne',
        'findEvents',
        'create',
        'update',
        'remove',
        'restore',
        'addLine',
        'updateLine',
        'removeLine',
      ],
      PHASE_3,
    ),
    unexposed(
      SuppliersController,
      ['findAll', 'findOne', 'create', 'update', 'remove', 'restore'],
      PHASE_3,
    ),
    unexposed(
      SuggestionsController,
      ['suggest'],
      'Not applicable: typing suggestions for the web smart-entry fields; the AI reads the records they come from through their own tools.',
    ),
  ],
};
