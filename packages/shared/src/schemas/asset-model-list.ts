import { z } from "zod";
import { AssetModelSchema } from "./asset-model";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /asset-models` envelope (ADR-0030). The AssetModel row is small (the `specs` jsonb
 * aside), so the list item is the full {@link AssetModelSchema} — only the page envelope is added.
 *
 * Migrated off the raw-array contract (issue #199) so the model picker can search server-side (`q`
 * over name/manufacturer/sku) and page authoritatively instead of materializing every model
 * client-side. The flat-array consumers (the asset form's model select, the Settings → Taxonomies
 * table) keep working unchanged: their hook requests the max page and reads `items` — exactly the
 * pattern Users/Locations already use (ADR-0030).
 */
export const AssetModelListPageSchema = pageSchema(AssetModelSchema);

export type AssetModelListPage = z.infer<typeof AssetModelListPageSchema>;
