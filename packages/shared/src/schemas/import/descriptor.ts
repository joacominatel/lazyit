import type { CreateAsset } from "../asset";
import { AssetStatusSchema } from "../asset";
import type { ImportEntity } from "./session";

/**
 * Migrator import — the entity-adapter registry (ADR-0069 §4/§5, #627): the SCALE SEAM.
 *
 * Each importable entity is described by PLAIN DATA — mappable fields (with i18n keys), the natural
 * key, the FK references and how to resolve them, and the closed-enum synonym maps. **Asset is the
 * only entry in phase 1.** Adding an entity later = add a descriptor and register it — NO
 * interface-with-one-impl ceremony, just a typed const + a registry object (the resolution/commit
 * engines that read this are later waves). The mappable-field keys are constrained to the entity's
 * real create-schema keys, so a descriptor cannot drift from the schema it feeds.
 */

/** How a FK reference is resolved to an existing row by natural key (ADR-0069 §5). */
export interface FkReference {
  /** The referenced entity (informational; resolution engine maps it to a model — later wave). */
  entity: string;
  /**
   * Ordered natural-key fields to match on. The FIRST is tried as an exact match; later ones are
   * fallbacks offered as candidates (e.g. AssetModel: `sku` exact, else soft `(manufacturer, name)`).
   */
  matchBy: readonly string[];
}

/** One mappable field on the target entity, with the i18n key the UI labels it with. */
export interface MappableField<TKey extends string> {
  field: TKey;
  /** i18n message key for the field label in the mapping UI. */
  i18nKey: string;
  /** True for fields the create schema requires with no default (must be mapped or pinned). */
  required: boolean;
}

/**
 * A typed, plain-data description of how to import one entity. `TCreate` ties the mappable keys, the FK
 * keys and the enum keys to the entity's real create-schema shape so the descriptor cannot reference a
 * field the schema doesn't have.
 */
export interface ImportDescriptor<TCreate> {
  /** Fields the operator can map a column / constant to. */
  mappableFields: readonly MappableField<Extract<keyof TCreate, string>>[];
  /** The natural key used to dedupe / match rows of THIS entity (e.g. `serial` for Asset). */
  naturalKey: Extract<keyof TCreate, string>;
  /** FK fields resolved by natural key, keyed by the create-schema field. */
  references: Partial<Record<Extract<keyof TCreate, string>, FkReference>>;
  /** Synonym maps for closed-enum fields: enum members + the source-value synonyms that map to them. */
  enumValueMaps: Partial<
    Record<Extract<keyof TCreate, string>, { members: readonly string[]; synonyms: Record<string, string> }>
  >;
}

/**
 * Asset import descriptor (the only phase-1 entity). Mappable: `name`, `serial`, `assetTag`, plus the
 * FK-resolved `modelId` / `locationId`; `status` is the closed enum. Natural key = `serial` (the asset's
 * only natural key — ADR-0069 §9; re-upload is NOT deduped unless serial is mapped). FK references:
 * model by sku-else-(manufacturer,name), location by name. (Category is resolved THROUGH the model in
 * the real schema — `CreateAssetSchema` has no direct `category`; the model carries it.)
 *
 * ponytail: `category` is not a `CreateAssetSchema` key, so the ADR's "category by name" reference can't
 * be expressed as a direct mappable FK here — it lives on AssetModel. Ceiling: phase-1 category linkage
 * rides the model. Upgrade path: if assets ever take a direct category FK, add it to the schema first,
 * then to `references` here.
 */
export const assetImportDescriptor: ImportDescriptor<CreateAsset> = {
  mappableFields: [
    { field: "name", i18nKey: "import.asset.field.name", required: true },
    { field: "serial", i18nKey: "import.asset.field.serial", required: false },
    { field: "assetTag", i18nKey: "import.asset.field.assetTag", required: false },
    { field: "status", i18nKey: "import.asset.field.status", required: true },
    { field: "modelId", i18nKey: "import.asset.field.model", required: false },
    { field: "locationId", i18nKey: "import.asset.field.location", required: false },
  ],
  naturalKey: "serial",
  references: {
    modelId: { entity: "AssetModel", matchBy: ["sku", "name"] },
    locationId: { entity: "Location", matchBy: ["name"] },
  },
  enumValueMaps: {
    status: {
      members: AssetStatusSchema.options,
      synonyms: {
        active: "OPERATIONAL",
        operational: "OPERATIONAL",
        "in use": "OPERATIONAL",
        repair: "IN_MAINTENANCE",
        maintenance: "IN_MAINTENANCE",
        storage: "IN_STORAGE",
        stored: "IN_STORAGE",
        spare: "IN_STORAGE",
        retired: "RETIRED",
        decommissioned: "RETIRED",
        disposed: "RETIRED",
        lost: "LOST",
        stolen: "LOST",
        missing: "LOST",
      },
    },
  },
};

/**
 * The entity-adapter registry. Adding an entity later = add an enum member to `ImportEntitySchema` and
 * a descriptor here — no other plumbing. Asset is the only entry now.
 */
// ponytail: the value type is `ImportDescriptor<unknown>` (erased) because each descriptor is generic
// over a different create shape; the descriptors themselves stay fully typed at their definition site.
// Ceiling: callers reading from the registry get the erased shape. Upgrade path: a mapped registry type
// per entity if/when a consumer needs the exact create shape back out of the map.
export const IMPORT_DESCRIPTORS: Record<ImportEntity, ImportDescriptor<unknown>> = {
  asset: assetImportDescriptor as ImportDescriptor<unknown>,
};
